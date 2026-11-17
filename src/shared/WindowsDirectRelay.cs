using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace CardBush {
// Loopback CONNECT relay. Only socket-scoped Windows interface selection is used.
// TLS remains end-to-end in Node; this process never decrypts platform traffic.
public sealed class WindowsDirectRelay : IDisposable {
    readonly int index;
    readonly string[] dns;
    readonly string authorization;
    readonly TcpListener listener = new TcpListener(IPAddress.Loopback, 0);
    readonly ConcurrentDictionary<TcpClient, byte> clients = new ConcurrentDictionary<TcpClient, byte>();
    readonly SemaphoreSlim limit = new SemaphoreSlim(32);
    volatile bool stopped;
    public WindowsDirectRelay(int index, string[] dns, string token) {
        if (token == null || token.Length < 40) throw new ArgumentException("invalid_token");
        this.index = index; this.dns = dns;
        authorization = "Basic " + Convert.ToBase64String(Encoding.UTF8.GetBytes("bridge:" + token));
    }
    public int Start() { listener.Start(32); Task.Run((Func<Task>)Accept); return ((IPEndPoint)listener.LocalEndpoint).Port; }
    async Task Accept() {
        while (!stopped) {
            TcpClient client;
            try { client = await listener.AcceptTcpClientAsync().ConfigureAwait(false); } catch { break; }
            if (!limit.Wait(0)) { client.Close(); continue; }
            clients.TryAdd(client, 0);
            Observe(Task.Run(async delegate { try { await Handle(client).ConfigureAwait(false); } finally {
                byte unused; clients.TryRemove(client, out unused); client.Close(); limit.Release();
            }}));
        }
    }
    static void Observe(Task task) { task.ContinueWith(t => { var ignored = t.Exception; }, TaskContinuationOptions.OnlyOnFaulted); }
    Socket Bound(SocketType type, ProtocolType protocol) {
        var socket = new Socket(AddressFamily.InterNetwork, type, protocol);
        socket.SetSocketOption(SocketOptionLevel.IP, (SocketOptionName)31, IPAddress.HostToNetworkOrder(index));
        socket.ReceiveTimeout = 3000; socket.SendTimeout = 3000;
        return socket;
    }
    static bool Fake(IPAddress ip) { var b = ip.GetAddressBytes(); return b.Length == 4 && b[0] == 198 && (b[1] == 18 || b[1] == 19); }
    IPAddress[] Resolve(string host) {
        IPAddress literal;
        if (IPAddress.TryParse(host, out literal)) {
            if (literal.AddressFamily != AddressFamily.InterNetwork || Fake(literal)) throw new IOException("direct_address_unavailable");
            return new[] { literal };
        }
        host = new IdnMapping().GetAscii(host).TrimEnd('.');
        if (host.Length > 253) throw new IOException("invalid_host");
        var query = new List<byte>(new byte[12]);
        var id = Guid.NewGuid().ToByteArray(); query[0] = id[0]; query[1] = id[1]; query[2] = 1; query[5] = 1;
        foreach (var label in host.Split('.')) {
            if (label.Length < 1 || label.Length > 63) throw new IOException("invalid_host");
            query.Add((byte)label.Length); query.AddRange(Encoding.ASCII.GetBytes(label));
        }
        query.AddRange(new byte[] { 0, 0, 1, 0, 1 });
        foreach (var server in dns) {
            try {
                using (var socket = Bound(SocketType.Dgram, ProtocolType.Udp)) {
                    socket.Connect(IPAddress.Parse(server), 53); socket.Send(query.ToArray());
                    var buffer = new byte[4096]; int count = socket.Receive(buffer);
                    if (count < 12 || buffer[0] != id[0] || buffer[1] != id[1] || (buffer[2] & 128) == 0 || (buffer[2] & 2) != 0 || (buffer[3] & 15) != 0) continue;
                    int pos = 12, questions = Read16(buffer, 4), answers = Read16(buffer, 6);
                    for (int i = 0; i < questions; i++) { SkipName(buffer, ref pos, count); pos += 4; }
                    var addresses = new List<IPAddress>();
                    for (int i = 0; i < answers; i++) {
                        SkipName(buffer, ref pos, count); if (pos + 10 > count) throw new IOException();
                        int type = Read16(buffer, pos), cls = Read16(buffer, pos + 2), size = Read16(buffer, pos + 8); pos += 10;
                        if (pos + size > count) throw new IOException();
                        if (type == 1 && cls == 1 && size == 4) {
                            var ip = new IPAddress(new byte[] { buffer[pos], buffer[pos+1], buffer[pos+2], buffer[pos+3] });
                            if (!Fake(ip)) addresses.Add(ip);
                        }
                        pos += size;
                    }
                    if (addresses.Count > 0) return addresses.ToArray();
                }
            } catch { }
        }
        throw new IOException("direct_dns_failed");
    }
    static int Read16(byte[] b, int p) { return (b[p] << 8) | b[p+1]; }
    static void SkipName(byte[] b, ref int p, int count) {
        int steps = 0;
        while (p < count && ++steps < 128) {
            int n = b[p++]; if (n == 0) return;
            if ((n & 192) == 192) { if (p >= count) break; p++; return; }
            if (n > 63 || p + n > count) break; p += n;
        }
        throw new IOException("invalid_dns_response");
    }
    async Task Handle(TcpClient client) {
        bool connected = false;
        try {
            client.ReceiveTimeout = 10000; var stream = client.GetStream();
            var bytes = new List<byte>();
            while (bytes.Count < 8192) {
                int b = stream.ReadByte(); if (b < 0) return; bytes.Add((byte)b);
                int n = bytes.Count;
                if (n >= 4 && bytes[n-4] == 13 && bytes[n-3] == 10 && bytes[n-2] == 13 && bytes[n-1] == 10) break;
            }
            var lines = Encoding.ASCII.GetString(bytes.ToArray()).Split(new[] { "\r\n" }, StringSplitOptions.None);
            var request = lines[0].Split(' '); bool authorized = false;
            foreach (var line in lines) {
                int colon = line.IndexOf(':');
                if (colon > 0 && line.Substring(0, colon).Equals("Proxy-Authorization", StringComparison.OrdinalIgnoreCase)) authorized = line.Substring(colon+1).Trim() == authorization;
            }
            if (!authorized) { Write(stream, "HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n"); return; }
            Uri target;
            if (request.Length != 3 || request[0] != "CONNECT" || !Uri.TryCreate("https://" + request[1], UriKind.Absolute, out target)
                || target.UserInfo.Length > 0 || target.AbsolutePath != "/" || target.Query.Length > 0 || target.Fragment.Length > 0) throw new IOException();
            Socket remote = null;
            foreach (var address in Resolve(target.DnsSafeHost)) {
                var candidate = Bound(SocketType.Stream, ProtocolType.Tcp);
                try {
                    var task = Task.Factory.FromAsync(candidate.BeginConnect, candidate.EndConnect, address, target.Port, null);
                    if (await Task.WhenAny(task, Task.Delay(5000)).ConfigureAwait(false) != task) throw new IOException();
                    await task.ConfigureAwait(false); remote = candidate; break;
                } catch { candidate.Dispose(); }
            }
            if (remote == null) throw new IOException("direct_connect_failed");
            using (var upstream = new NetworkStream(remote, true)) {
                Write(stream, "HTTP/1.1 200 Connection Established\r\n\r\n"); connected = true;
                await Task.WhenAny(stream.CopyToAsync(upstream), upstream.CopyToAsync(stream)).ConfigureAwait(false);
            }
        } catch { if (!connected) { try { Write(client.GetStream(), "HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n"); } catch { } } }
    }
    static void Write(Stream stream, string value) { var b = Encoding.ASCII.GetBytes(value); stream.Write(b, 0, b.Length); }
    public void Dispose() { stopped = true; listener.Stop(); foreach (var c in clients.Keys) c.Close(); }
}
}

param([ValidateSet('direct', 'system')][string]$Mode = 'direct')
$ErrorActionPreference = 'Stop'
try {
  if ($Mode -eq 'system') {
    while ($line = [Console]::ReadLine()) {
      try {
        $uri = [Uri]$line
        $proxy = [Net.WebRequest]::GetSystemWebProxy()
        $target = $proxy.GetProxy($uri)
        @{ proxy = $(if ($proxy.IsBypassed($uri) -or $target -eq $uri) { '' } else { $target.AbsoluteUri }) } | ConvertTo-Json -Compress
      } catch { @{ error = 'system_proxy_unavailable' } | ConvertTo-Json -Compress }
    }
    exit
  }
  # Choose a real uplink. Do not change routes, DNS, VPN or system proxy settings.
  $physical = @(Get-NetAdapter -Physical | Where-Object Status -eq 'Up' | Select-Object -ExpandProperty ifIndex)
  $routes = @(Get-NetRoute -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0' | Where-Object { $_.InterfaceIndex -in $physical })
  $selected = $routes | Sort-Object @{ Expression = { $_.RouteMetric + (Get-NetIPInterface -AddressFamily IPv4 -InterfaceIndex $_.InterfaceIndex).InterfaceMetric } } | Select-Object -First 1
  if (!$selected) { throw 'direct_interface_unavailable' }
  $servers = @((Get-DnsClientServerAddress -InterfaceIndex $selected.InterfaceIndex -AddressFamily IPv4).ServerAddresses | Where-Object { $_ -and $_ -notmatch '^(127\.|198\.(18|19)\.)' })
  if (!$servers.Count) { throw 'direct_dns_unavailable' }
  Add-Type -Path (Join-Path $PSScriptRoot 'WindowsDirectRelay.cs')
  $token = [Console]::ReadLine()
  $relay = [CardBush.WindowsDirectRelay]::new([int]$selected.InterfaceIndex, [string[]]$servers, $token)
  @{ port = $relay.Start() } | ConvertTo-Json -Compress
  # The parent keeps stdin open. EOF shuts down every socket, including after a crash.
  [Console]::ReadLine() | Out-Null
  $relay.Dispose()
} catch { @{ error = 'windows_network_unavailable' } | ConvertTo-Json -Compress; exit 1 }

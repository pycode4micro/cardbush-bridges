// Tests execute the real CLI with a private temporary profile. Never contact a platform.
import { localServiceFetch } from '../../../src/shared/local-http.mjs';
const local = new URL(process.env.CARDBUSH_WEBHOOK_URL);
globalThis.fetch = async (input, options) => {
  const url = new URL(input);
  if (url.origin === local.origin) return localServiceFetch(input, options);
  if (url.origin === 'https://ilinkai.weixin.qq.com') {
    if (url.pathname === '/ilink/bot/get_bot_qrcode') {
      await localServiceFetch(new URL('/fixture/qr-requested', local), { method: 'POST' });
      return Response.json({ qrcode: 'fixture-qr', qrcode_img_content: 'https://example.invalid/fixture-qr' });
    }
    if (url.pathname === '/ilink/bot/get_qrcode_status') return Response.json({ status: 'confirmed',
      bot_token: 'fixture-account', ilink_bot_id: 'fixture-bot', ilink_user_id: 'fixture-user' });
  }
  throw Error('Unexpected network access in CLI test');
};

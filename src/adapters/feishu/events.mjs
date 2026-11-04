// Only platform data enters the generic envelope; no model, permissions or URLs.
export function normalizeMessage(event, botOpenId, allowedChats = []) {
  const data = event?.event ?? event, message = data?.message, sender = data?.sender;
  if (sender?.sender_type !== 'user' || typeof sender.sender_id?.open_id !== 'string' || !sender.sender_id.open_id || sender.sender_id.open_id === botOpenId
    || typeof message?.message_id !== 'string' || !message.message_id || typeof message.chat_id !== 'string' || !message.chat_id.startsWith('oc_')) return;
  const mentions = Array.isArray(message.mentions) ? message.mentions : [];
  if (message.chat_type !== 'p2p') {
    if (message.chat_type !== 'group' || !allowedChats.includes(message.chat_id) || !mentions.some(m => m?.id?.open_id === botOpenId)) return;
  }
  let content; try { content = JSON.parse(message.content); } catch { return; }
  if (!content || typeof content !== 'object') return;
  let text = '';
  if (message.message_type === 'text') text = typeof content.text === 'string' ? content.text : '';
  else if (message.message_type === 'post') {
    const post = content.content ? content : content.zh_cn ?? content.en_us;
    const lines = Array.isArray(post?.content) ? post.content.filter(Array.isArray) : [];
    text = [typeof post?.title === 'string' ? post.title : '', ...lines.map(line => line.map(item => item?.tag === 'text' && typeof item.text === 'string' ? item.text
      : item?.tag === 'a' && typeof item.text === 'string' && typeof item.href === 'string' ? `${item.text} (${item.href})` : '').join(''))].filter(Boolean).join('\n');
  }
  for (const mention of mentions) if (mention?.id?.open_id === botOpenId && typeof mention.key === 'string' && mention.key) text = text.split(mention.key).join('');
  text = text.trim();
  return { id: message.message_id, senderId: sender.sender_id.open_id, conversationId: message.chat_id, chatType: message.chat_type,
    text, unsupported: !text || text.length > 32000, createdAt: Number(message.create_time) || Date.now() };
}

import { createHmac, timingSafeEqual } from 'node:crypto';

import officialMenu from '../config/vkus-vostoka.menu.json' with { type: 'json' };
export const products=officialMenu.products;
export const extras=officialMenu.extras;
export function priceCart(items, unavailable = [], menu = products, additions = extras) {
  if (!Array.isArray(items) || !items.length || items.length > 30) throw new Error('Добавьте блюда в корзину');
  return items.map(item => {
    const p = menu.find(p => p.id === item.id);
    if (!p || unavailable.includes(p.id)) throw new Error('Блюдо сейчас недоступно');
    if (!Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 20) throw new Error('Недопустимое количество');
    const ids = item.extras ?? [];
    if (!Array.isArray(ids) || ids.length > additions.length || new Set(ids).size !== ids.length) throw new Error('Проверьте добавки');
    const selected = ids.map(id => { const e=additions.find(e=>e.id===id); if(!e) throw new Error('Неизвестная добавка'); return e; });
    const customizable=['shawarma','veggie'].includes(p.category);
    if (!customizable && ids.length) throw new Error('Добавки доступны только для шаурмы');
    const size = item.size ?? 'regular';
    if (!['regular','large'].includes(size) || ((!customizable||p.allowLarge===false) && size !== 'regular')) throw new Error('Недопустимый размер');
    const unitPrice = p.price + (size==='large'?90:0) + selected.reduce((s,e)=>s+e.price,0);
    return {id:p.id,name:p.name,quantity:item.quantity,size,extras:selected.map(({id,name,price})=>({id,name,price})),unitPrice};
  });
}
export function validateTelegram(raw, token, now = Date.now()) {
  const params = new URLSearchParams(raw);
  const hash = params.get('hash'); params.delete('hash');
  if (!hash || !/^[a-f0-9]{64}$/i.test(hash)) throw new Error('Откройте приложение из Telegram');
  const keys = [...params.keys()];
  if (new Set(keys).size !== keys.length) throw new Error('Некорректные данные Telegram');
  const check = [...params.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${k}=${v}`).join('\n');
  const secret = createHmac('sha256','WebAppData').update(token).digest();
  const expected = createHmac('sha256',secret).update(check).digest();
  if (!timingSafeEqual(expected,Buffer.from(hash,'hex'))) throw new Error('Подпись Telegram не совпадает');
  const age=now/1000-Number(params.get('auth_date'));
  if (!Number.isFinite(age) || age < -30 || age > 3600) throw new Error('Откройте приложение заново в Telegram');
  const user=JSON.parse(params.get('user')||'null');
  if (!Number.isSafeInteger(user?.id) || user.id<=0) throw new Error('Не удалось подтвердить пользователя');
  return user;
}
export function paymentMatches(payment, order, mode) {
  return payment.id===order.paymentId && payment.status==='succeeded' && payment.paid===true && payment.amount?.currency==='RUB' && payment.amount?.value===(order.total).toFixed(2) && payment.metadata?.order_id===order.id && payment.test===(mode==='yookassa_test');
}

import { createHmac, timingSafeEqual } from 'node:crypto';

export const products = [
  { id:'classic', name:'Та самая классика', description:'Курица с огня, свежие овощи, маринованный огурчик и наш чесночный соус.', price:290, weight:350, category:'shawarma', badge:'ХИТ', color:'yellow', image:'classic.webp', ingredients:'Курица, лаваш, капуста, томат, огурец, чесночный соус', allergens:'Глютен, молоко, яйца' },
  { id:'cheese', name:'Сырный беспредел', description:'Сочная курица, двойной чеддер и нежный сырный соус. Сыра много. Очень.', price:350, weight:380, category:'shawarma', badge:'СЫ-Ы-ЫР!', color:'orange', image:'cheese.webp', ingredients:'Курица, лаваш, чеддер, капуста, томат, сырный соус', allergens:'Глютен, молоко, яйца' },
  { id:'spicy', name:'Огонь, а не шаурма', description:'Курица, халапеньо, морковка по-корейски и соус шрирача. С характером.', price:330, weight:360, category:'shawarma', badge:'ОСТРАЯ', color:'pink', image:'spicy.webp', ingredients:'Курица, лаваш, капуста, морковь по-корейски, халапеньо, шрирача', allergens:'Глютен, соя' },
  { id:'falafel', name:'Зелёный свет', description:'Хрустящий фалафель, овощи, хумус и тахини. Вся любовь — в растениях.', price:310, weight:340, category:'veggie', badge:'БЕЗ МЯСА', color:'green', image:'falafel.webp', ingredients:'Фалафель, лаваш, хумус, томат, огурец, капуста, тахини', allergens:'Глютен, кунжут' },
  { id:'fries', name:'Картошка, как надо', description:'Золотистая, хрустящая, с паприкой. Идеальная компания для шаурмы.', price:150, weight:150, category:'sides', badge:'ХРУСТЬ', color:'yellow', image:'fries.webp', ingredients:'Картофель, растительное масло, паприка, соль', allergens:'Возможны следы глютена' },
  { id:'lemonade', name:'Лимонад «Цитрус»', description:'Лимон, апельсин и немного пузырьков. Освежает даже после острой.', price:140, weight:400, category:'drinks', badge:'ОСВЕЖИСЬ', color:'green', image:'lemonade.webp', ingredients:'Вода, лимон, апельсин, сахар', allergens:'Нет' }
];
export const extras = [
  {id:'cheddar',name:'Сыр чеддер',price:50,icon:'🧀'},
  {id:'chicken',name:'Ещё курицы',price:80,icon:'🍗'},
  {id:'carrot',name:'Морковка по-корейски',price:35,icon:'🥕'},
  {id:'fries',name:'Картошка фри',price:45,icon:'🍟'},
  {id:'jalapeno',name:'Халапеньо',price:30,icon:'🌶️'},
  {id:'sauce',name:'Больше соуса',price:25,icon:'🥣'}
];
export function priceCart(items, unavailable = [], menu = products, additions = extras) {
  if (!Array.isArray(items) || !items.length || items.length > 30) throw new Error('Добавьте блюда в корзину');
  return items.map(item => {
    const p = menu.find(p => p.id === item.id);
    if (!p || unavailable.includes(p.id)) throw new Error('Блюдо сейчас недоступно');
    if (!Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 20) throw new Error('Недопустимое количество');
    const ids = item.extras ?? [];
    if (!Array.isArray(ids) || ids.length > additions.length || new Set(ids).size !== ids.length) throw new Error('Проверьте добавки');
    const selected = ids.map(id => { const e=additions.find(e=>e.id===id); if(!e) throw new Error('Неизвестная добавка'); return e; });
    if (['sides','drinks'].includes(p.category) && ids.length) throw new Error('Добавки доступны только для шаурмы');
    const size = item.size ?? 'regular';
    if (!['regular','large'].includes(size) || (['sides','drinks'].includes(p.category) && size !== 'regular')) throw new Error('Недопустимый размер');
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

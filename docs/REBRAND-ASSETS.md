# Ребрендинг «Вкус востока» — 14 октября 2026

## Источники

Название, адрес «Москва, ул. Академика Волгина, 1» и круглосуточный график подтверждены заказчиком. Цены и позиции перенесены с предоставленной фотографии меню. Фотография фасада предоставлена заказчиком и сохранена без изменений в `public/assets/vkus-vostoka-storefront.png`.

| Позиция | Цена, ₽ |
| --- | ---: |
| Шаурма классическая | 270 |
| Шаурма в сырном лаваше | 280 |
| Шаурма в чесночном лаваше | 280 |
| Шаурма в лепёшке | 300 |
| Плов + салат + лепёшка | 380 |
| Манты + сметана + лепёшка | 380 |
| Курица-гриль целая | 650 |
| Половина курицы-гриль | 325 |
| Хот-дог двойной | 210 |
| Кофе 3 в 1 | 60 |
| Кофе чёрный | 60 |
| Чай | 50 |
| Добавка: сыр | 30 |
| Добавка: халапеньо | 30 |

Фактические вес, объём напитков, состав и аллергены на фото не указаны. Поэтому вес хранится как 0 («не указан»), а в карточках показана порция. Не вводились неподтверждённые размеры XL или дополнительные надбавки. Фотографии блюд — созданные иллюстрации, а не фотографии реальной подачи; это указано на странице. Детали на изображении, включая количество мантов, не задают размер продаваемой порции.

## Перенос данных

Исходное меню: `config/vkus-vostoka.menu.json`. При первом запуске версии с миграцией `photo-menu-2026-10-14` для точки «Вкус востока» в Москве заменяются прежние демонстрационные блюда и добавки, устанавливаются адрес и график 24/7. Отдельно созданные владельцем блюда с другими ID сохраняются. Старые заказы и их цены не меняются. Миграция выполняется один раз: последующие изменения цен и графика в админке не перезаписываются при рестарте. Приём заказов, который вручную приостановили в админке, автоматически не включается.

## Визуальное направление

Тёплая бумага `#f7f0e3`, гранатовый `#852f3b`, керамическая бирюза `#215c59`. Арочная фотография, геометрический орнамент, спокойная антиква Georgia и локальный Manrope. Орнамент `public/assets/east-pattern.svg` и favicon созданы средствами SVG. Основная тема: `public/east.css`.

## Изображения и запросы ImageGen

Оригинальные PNG сохранены в локальной папке генераций Codex. Для сайта созданы WebP шириной 850 px (главный плов — 1400 px), качество 86. Приведённые ниже файлы находятся в репозитории.

Общая часть запроса для первых пяти изображений; вместо `{SUBJECT}` использовано соответствующее описание:

```text
Use case: product-mockup. Asset: restaurant website food photography illustration, single landscape photograph, 3:2 aspect ratio. Subject: {SUBJECT}. Scene: warm ivory travertine tabletop, subtly textured saffron beige background, a small folded burgundy linen napkin. Authentic Central Asian food, editorial appetizing food photography, realistic textures, natural warm side light, soft shadows. Close three-quarter overhead view, entire dish visible with margin around edges, generous portions, refined restaurant editorial composition. No people, no writing, no logo, no frame, no collage, no watermark. Palette of warm cream, pomegranate red and turquoise. This is illustrative menu photography, not evidence of actual restaurant serving.
```

### public/assets/east-plov.webp

SUBJECT: A generous ceramic turquoise patterned plate of Uzbek plov with golden rice, tender pieces of beef, carrots, a whole roasted garlic bulb, alongside a small tomato cucumber salad and one round Uzbek non flatbread. Main plate dominates.

### public/assets/east-manti.webp

SUBJECT: A turquoise Uzbek ceramic platter of six hand-pleated steamed manti dumplings, a small white bowl of sour cream and a round Uzbek non flatbread alongside.

### public/assets/east-chicken.webp

SUBJECT: One whole golden roast grilled chicken with crispy burnished skin, on an ornate turquoise Uzbek ceramic platter. A few fresh herbs, no side dishes.

### public/assets/east-hotdog.webp

SUBJECT: One double hot dog: a single soft long roll with two sausages side by side, ketchup and mustard, simple shredded cabbage, on parchment on a small turquoise ceramic plate.

### public/assets/east-tea.webp

SUBJECT: A small traditional Central Asian turquoise ceramic tea bowl filled with amber black tea beside a modest black ceramic cup of black coffee, on a brass tray. No sugar, no desserts.

### public/assets/east-bread.webp

Полный запрос:

```text
Use case: product-mockup. Asset: restaurant website illustrative food photograph, single landscape photograph, 3:2 aspect ratio. Subject: A single shawarma sandwich in a round Uzbek flatbread: round thick golden bread split horizontally, clearly a round sandwich and NOT a rolled lavash wrap, filled with grilled sliced chicken, cabbage and tomato, on a turquoise patterned ceramic plate. Scene: warm ivory travertine tabletop, subtly textured saffron beige background, a small folded burgundy linen napkin. Authentic food, editorial appetizing food photography, realistic textures, natural warm side light, soft shadows. Close three-quarter overhead view, entire dish visible with margin around edges, refined restaurant editorial composition. No people, no writing, no logo, no frame, no collage, no watermark. Palette of warm cream, pomegranate red and turquoise. This is illustrative menu photography, not evidence of actual restaurant serving.
```

### public/assets/east-half-chicken.webp

Полный запрос:

```text
Use case: product-mockup. Asset: restaurant website illustrative food photograph, single landscape photograph, 3:2 aspect ratio. Subject: Exactly one HALF of a grilled roast chicken, a single cut half with one leg, one wing and one breast, cut side visibly facing camera. Not a whole chicken, not two halves. On a turquoise patterned ceramic plate with a little green parsley, no sides. Scene: warm ivory travertine tabletop, subtly textured saffron beige background, a small folded burgundy linen napkin. Authentic food, editorial appetizing food photography, realistic textures, natural warm side light, soft shadows. Close three-quarter overhead view, entire dish visible with margin around edges, refined restaurant editorial composition. No people, no writing, no logo, no frame, no collage, no watermark. Palette of warm cream, pomegranate red and turquoise. This is illustrative menu photography, not evidence of actual restaurant serving.
```

## Проверка

`npm run build`, `npm test`, `npm run test:browser`. Браузерная проверка создаёт отдельную временную базу, проходит заказ, демо-оплату, выдачу, возврат, настройки и редактирование меню. Скриншоты находятся в исключённой из Git папке `test-results`. Эти проверки не проводят платёж через внешний API ЮKassa.

# Тема «Zaklex» (в архиве)

Тёмная тема в стиле SHAPE MOTION (макет — `mockups/shape-motion.html`). Была в программе с 1.15 по 1.17.1, в 1.18.0 убрана: её заменила тема «macOS (бета)». Тех, у кого была выбрана «Zaklex», программа сама переводит на «macOS» в тёмном оформлении.

Эта папка не входит в установщик (`build.files` в `package.json`), она хранится только в репозитории, чтобы тему можно было переделать.

Что здесь лежит:
- `theme-zaklex.css` — сама тема (бывший `src/theme-zaklex.css`), правила обёрнуты в `:where(html[data-theme="zaklex"])`.
- `screenshots-zaklex.css` — её часть для раздела «Снимки» (была в конце `src/screenshots.css`).
- `fonts.css` и папка `fonts` — шрифты темы: Roboto Condensed 700/900, Onest, JetBrains Mono, Unbounded 800.

Как вернуть: положить файлы обратно в `src/` (шрифты — в `src/fonts`, `@font-face` — в конец `src/fonts.css`, блок снимков — в `src/screenshots.css`), подключить `theme-zaklex.css` в `src/index.html` и `src/capture-editor.html`, добавить `zaklex` в `THEMES` и `WINDOW_COLORS` в `main.js` и в меню «Тема» (`index.html`, `THEME_NAMES` и `markTheme` в `app.js`).

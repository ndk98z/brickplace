// The admin page's stylesheet, served as /admin.css. Colours, radii and type sizes come from the
// "Admin & moderation" artboard of the UI design. The page's CSP allows no web fonts, so the
// artboard's Fredoka and Inter fall back to the system's rounded and plain sans faces.

export const ADMIN_CSS = `
:root {
  color-scheme: light;
  --ink: #171B26; --ink-2: #3B4256; --muted: #5A6175; --ground: #EEF1F7; --card: #FFFFFF;
  --line: #E4E8F0; --field: #C9D0DE;
  --side: #171B26; --side-ink: #D5DAE5; --side-on: #3B4256; --side-dim: #B5BCCB;
  --accent: #FFD23F; --badge: #FF6B3D; --warn: #FFF1A8; --warn-ink: #5C4A00;
  --red: #8F2236; --red-line: #B13E53; --red-soft: #FDE4E8;
  --green: #1E7F5C; --green-soft: #E8F7EF; --blue: #1F4FB8; --blue-soft: #E5EEFF;
  --grey-soft: #EEF1F7;
  --display: "Fredoka", ui-rounded, "SF Pro Rounded", system-ui, sans-serif;
  --text: "Inter", system-ui, -apple-system, "Segoe UI", sans-serif;
  --mono: ui-monospace, "SF Mono", Menlo, monospace;
}
* { box-sizing: border-box; }
[hidden] { display: none !important; }
html { scroll-padding-top: 16px; }
body { margin: 0; min-height: 100vh; font: 14px/1.5 var(--text); color: var(--ink);
  background: var(--ground); display: flex; align-items: stretch; }
a { color: inherit; }
h1, h2, h3 { font-family: var(--display); margin: 0; }
p { margin: 0; }
code, pre { font-family: var(--mono); }

/* Sidebar */
.side { flex: 0 0 240px; position: sticky; top: 0; height: 100vh; overflow-y: auto;
  padding: 24px 16px; background: var(--side); color: #fff;
  display: flex; flex-direction: column; gap: 4px; }
.brand { display: flex; align-items: center; gap: 10px; padding: 0 8px 20px;
  font: 700 20px/1.2 var(--display); }
.brand-pill { padding: 2px 8px; border-radius: 999px; background: var(--accent); color: var(--ink);
  font: 700 11px/1.6 var(--text); }
.nav { display: flex; flex-direction: column; gap: 2px; }
.nav-group { padding: 14px 12px 6px; font-size: 11px; font-weight: 700; letter-spacing: 0.08em;
  text-transform: uppercase; color: #9AA2B5; }
.nav-group:first-child { padding-top: 4px; }
.nav a { display: flex; align-items: center; justify-content: space-between; gap: 8px;
  padding: 10px 12px; border-radius: 10px; color: var(--side-ink); font-weight: 600;
  text-decoration: none; }
.nav a:hover { background: #262C3C; color: #fff; }
.nav a:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.nav a[aria-current="page"] { background: var(--side-on); color: #fff; }
.count { min-width: 24px; padding: 0 8px; border-radius: 999px; background: var(--badge);
  color: var(--ink); font-size: 12px; font-weight: 700; text-align: center; }
.who { margin-top: auto; padding: 16px 10px 0; font-size: 12px; color: var(--side-dim);
  overflow-wrap: anywhere; display: flex; flex-direction: column; gap: 6px; }
.who strong { color: #fff; font-weight: 600; font-size: 13px; }
.role-pill { align-self: flex-start; padding: 2px 8px; border-radius: 999px;
  background: var(--side-on); color: #fff; font-weight: 700; }

/* Main column */
.main { flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; }
.env { padding: 8px 28px; font-size: 13px; font-weight: 700; color: #fff; }
.env-production { background: #B3261E; }
.env-staging { background: #8A5A00; }
.env-dev { background: #2F5D9B; }
.content { width: 100%; max-width: 1280px; padding: 28px 28px 64px;
  display: flex; flex-direction: column; gap: 20px; }
.top { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.top h1 { font-size: 34px; font-weight: 700; line-height: 1.15; }
.top .push { margin-left: auto; }
.view { display: flex; flex-direction: column; gap: 20px; }
.lead { color: var(--muted); max-width: 80ch; }

/* Stat tiles */
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; }
.tile { padding: 18px; border-radius: 18px; background: var(--card); }
.tile-label { font-size: 12px; font-weight: 600; color: var(--muted); }
.tile-value { font: 600 30px/1.2 var(--display); margin-top: 2px; overflow-wrap: anywhere; }
.tile-sub { font-size: 13px; color: var(--muted); }
.tile.alert { background: var(--red-soft); }
.tile.alert .tile-value { color: var(--red); }

/* Cards */
.card { border-radius: 20px; background: var(--card); overflow: hidden; min-width: 0; }
.card-head { padding: 18px 20px; display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.card-head h2 { font-size: 22px; font-weight: 700; line-height: 1.25; }
.card-head .meta { font-size: 13px; color: var(--muted); }
.card-head .push { margin-left: auto; }
.card-body { padding: 0 20px 20px; display: flex; flex-direction: column; gap: 12px; }
.card-head + .table-wrap { border-top: 1px solid var(--line); }
.card-body + .table-wrap { border-top: 1px solid var(--line); }
.card-foot { padding: 14px 20px; border-top: 1px solid var(--line); display: flex; gap: 8px;
  flex-wrap: wrap; align-items: center; }
.pair { display: flex; gap: 20px; flex-wrap: wrap; align-items: stretch; }
.pair > .card { flex: 1 1 340px; display: flex; flex-direction: column; }
.pair > .card > .card-foot { margin-top: auto; }
.note { font-size: 12px; color: var(--muted); }
.facts { margin: 0; display: flex; flex-direction: column; gap: 10px; }
.facts div { display: flex; justify-content: space-between; gap: 12px; font-size: 14px; }
.facts dt { color: var(--muted); }
.facts dd { margin: 0; font-weight: 700; text-align: right; overflow-wrap: anywhere; }

/* Tables */
.table-wrap { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: 14px; }
th { padding: 12px 10px; text-align: left; color: var(--muted); font-size: 12px; font-weight: 600;
  text-transform: uppercase; letter-spacing: 0.05em; white-space: nowrap; }
td { padding: 12px 10px; text-align: left; vertical-align: middle; border-top: 1px solid var(--line); }
th:first-child, td:first-child { padding-left: 20px; }
th:last-child, td:last-child { padding-right: 20px; }
td.num { font-weight: 700; }
td.dim { color: var(--ink-2); white-space: nowrap; }
td.empty { padding: 24px 20px; color: var(--muted); }
th.acts, td.acts { text-align: right; }
.acts-in { display: flex; gap: 6px; justify-content: flex-end; flex-wrap: wrap; }
td .acts-in { flex-wrap: nowrap; }
td .acts-in button { padding: 0 10px; }
td.num .sub { white-space: nowrap; font-weight: 400; }
.who-cell { display: flex; align-items: center; gap: 12px; min-width: 160px; }
.who-cell .lines { display: flex; flex-direction: column; min-width: 0; }
.who-cell strong { overflow-wrap: anywhere; }
.sub { font-size: 12px; color: var(--muted); overflow-wrap: anywhere; }
.badge { flex-shrink: 0; width: 44px; height: 32px; border-radius: 8px;
  display: grid; place-items: center; font: 700 15px/1 var(--display);
  box-shadow: inset 0 -3px 0 rgba(0, 0, 0, 0.18); }
.badge.player { background: #3D7BFF; color: #fff; }
.badge.team { background: var(--accent); color: var(--ink); }
.pills { display: flex; flex-wrap: wrap; gap: 4px; }
.pill { display: inline-block; padding: 4px 10px; border-radius: 999px; font-size: 12px;
  font-weight: 700; white-space: nowrap; background: var(--grey-soft); color: var(--ink-2); }
.pill.red { background: var(--red-soft); color: var(--red); }
.pill.green { background: var(--green-soft); color: var(--green); }
.pill.blue { background: var(--blue-soft); color: var(--blue); }
.pill.yellow { background: var(--warn); color: var(--warn-ink); }
.top .pill { padding: 6px 12px; font-size: 13px; }
details summary { cursor: pointer; font-weight: 600; list-style: none; display: flex;
  align-items: center; gap: 6px; white-space: nowrap; }
details summary::-webkit-details-marker { display: none; }
details summary::before { content: "▸"; color: var(--muted); }
details[open] summary::before { content: "▾"; }
details pre, pre.block { margin: 8px 0 0; padding: 12px; border-radius: 12px;
  background: var(--ground); font-size: 12px; white-space: pre-wrap; word-break: break-word;
  max-width: 520px; }
details ul { margin: 8px 0 0; padding-left: 18px; }

/* Buttons */
button { font: inherit; font-size: 13px; font-weight: 600; min-height: 36px; padding: 0 12px;
  border-radius: 10px; cursor: pointer; white-space: nowrap; }
button:focus-visible, .nav a:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }
button:disabled { opacity: 0.5; cursor: default; }
.primary { border: 1px solid var(--ink); background: var(--ink); color: #fff; }
.primary:hover { background: var(--ink-2); }
.secondary { border: 1px solid var(--field); background: var(--card); color: var(--ink); }
.secondary:hover { border-color: var(--ink); }
.ghost { border: 1px solid transparent; background: transparent; color: var(--ink-2); }
.ghost:hover { background: var(--ground); }
.danger { border: 1px solid var(--red-line); background: var(--card); color: var(--red); }
.danger:hover { background: var(--red-soft); }
.danger.solid { background: var(--red); border-color: var(--red); color: #fff; }
.danger.solid:hover { background: #761B2C; }
.warn { border: 1.5px solid var(--ink); background: var(--warn); color: var(--ink); font-weight: 700; }
.warn:hover { background: #FFE877; }
.big { min-height: 40px; padding: 0 14px; }
.link { border: none; background: none; padding: 0; min-height: 0; color: inherit;
  font-size: inherit; text-align: left; white-space: normal; overflow-wrap: anywhere;
  text-decoration: underline; text-underline-offset: 2px; }
.link:hover { color: #C93A17; }

/* Forms */
form.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 12px;
  align-items: start; }
form.grid .wide { grid-column: 1 / -1; }
form.inline { display: flex; gap: 8px; flex-wrap: wrap; align-items: flex-end; }
form.inline .field { flex: 1 1 200px; max-width: 420px; }
form.inline .field.short { flex: 0 1 110px; }
.field { display: flex; flex-direction: column; gap: 4px; font-size: 13px; font-weight: 600; }
.field .hint { font-size: 12px; font-weight: 400; color: var(--muted); }
.check { display: flex; gap: 8px; align-items: center; font-size: 14px; }
input, select, textarea { font: inherit; font-weight: 400; min-height: 40px; padding: 8px 10px;
  border: 1px solid var(--field); border-radius: 10px; background: var(--card); color: var(--ink);
  width: 100%; }
input[type="checkbox"] { width: 18px; min-height: 18px; height: 18px; margin: 0; }
textarea { resize: vertical; }
textarea.code { font-family: var(--mono); font-size: 13px; }
input:focus, select:focus, textarea:focus { outline: 2px solid var(--ink); outline-offset: 1px; }
.buttons-row { display: flex; gap: 8px; flex-wrap: wrap; }
form.inline .result { align-self: center; }
.result { padding: 12px 14px; border-radius: 12px; background: var(--ground); font-size: 14px; }
.result.bad { background: var(--red-soft); color: var(--red); font-weight: 600; }

/* Dialog */
dialog { width: min(520px, calc(100vw - 32px)); padding: 0; border: none; border-radius: 20px;
  color: var(--ink); box-shadow: 0 24px 64px rgba(23, 27, 38, 0.3); }
dialog::backdrop { background: rgba(23, 27, 38, 0.55); }
dialog form { padding: 24px; display: flex; flex-direction: column; gap: 14px; }
dialog h2 { font-size: 22px; font-weight: 700; }
dialog .text { color: var(--ink-2); white-space: pre-line; }
dialog .buttons { display: flex; justify-content: flex-end; gap: 8px; padding-top: 4px; }
dialog.danger-ask h2 { color: var(--red); }

/* Toast */
.toast { position: fixed; right: 20px; bottom: 20px; z-index: 10; max-width: min(480px, calc(100vw - 40px));
  padding: 14px 16px; border-radius: 14px; background: var(--ink); color: #fff;
  box-shadow: 0 12px 32px rgba(23, 27, 38, 0.3); display: flex; gap: 12px; align-items: flex-start; }
.toast.error { background: var(--red); }
.toast p { flex: 1; overflow-wrap: anywhere; }
.toast button { min-height: 24px; padding: 0 8px; border: 1px solid rgba(255, 255, 255, 0.4);
  background: transparent; color: #fff; }

/* Layout helpers for the redesigned views */
.row { display: flex; gap: 20px; flex-wrap: wrap; align-items: flex-start; }
.row > .wide-col { flex: 3 1 460px; min-width: 0; }
.row > .narrow-col { flex: 2 1 320px; min-width: 0; }
.stack { display: flex; flex-direction: column; gap: 20px; }
.view-bar { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.view-bar .push { margin-left: auto; }
.view-bar .grow { flex: 1 1 320px; }
h3 { font-family: var(--text); font-size: 16px; font-weight: 700; }

/* Segmented choices and tabs */
.seg { display: flex; gap: 8px; flex-wrap: wrap; }
.seg-btn { min-height: 56px; padding: 8px 16px; border-radius: 14px; border: 1px solid var(--field);
  background: var(--card); color: var(--ink); text-align: left; display: flex; flex-direction: column;
  align-items: flex-start; justify-content: center; gap: 2px; white-space: normal; }
.seg-btn strong { font-size: 14px; }
.seg-btn span { font-size: 12px; font-weight: 500; opacity: 0.85; }
.seg-btn[aria-pressed="true"] { border: 2px solid var(--ink); background: var(--ink); color: #fff; }
.chips { display: flex; gap: 6px; flex-wrap: wrap; }
.chip { min-height: 32px; padding: 0 12px; border-radius: 999px; border: 1px solid var(--field);
  background: var(--card); color: var(--ink); font-size: 12px; font-weight: 700; }
.chip.big { min-height: 40px; font-size: 13px; }
.chip[aria-pressed="true"] { border-color: var(--ink); background: var(--ink); color: #fff; }
.tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--line); padding: 0 20px; }
.tab { min-height: 44px; padding: 0 14px; border: none; border-radius: 0; background: transparent;
  color: var(--muted); font-size: 14px; font-weight: 700; border-bottom: 3px solid transparent;
  margin-bottom: -1px; }
.tab[aria-selected="true"] { color: var(--ink); border-bottom-color: var(--ink); }
.panel { padding: 20px; display: flex; flex-direction: column; gap: 20px; }

/* Number fields: steppers, changed and invalid states */
.fields3 { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 18px; }
.num-field { display: flex; flex-direction: column; gap: 8px; }
.num-field > label, .label { font-size: 13px; font-weight: 700; }
.num-row { display: flex; align-items: center; gap: 8px; }
.num-row .unit { color: var(--muted); }
input.num { width: 110px; font-size: 15px; min-height: 44px; }
input.num.short { width: 76px; }
input.changed { border: 2px solid #3D7BFF; background: #F2F6FF; }
input.bad { border: 2px solid var(--red-line); background: #FDF2F4; }
.step-btn { width: 44px; min-height: 44px; padding: 0; font-size: 20px; border: 1px solid var(--field);
  background: var(--card); color: var(--ink); }

/* Drop rate table */
.rates { border: 1px solid var(--line); border-radius: 14px; overflow-x: auto; }
.rates table { min-width: 780px; }
.rates thead tr { background: #F7F8FB; }
.rates td, .rates th { vertical-align: top; }
.rates th[scope="row"] { text-transform: none; letter-spacing: 0; font-size: 14px; color: var(--ink);
  white-space: normal; }
.rates td:last-child { width: 170px; }
.rates .pct { display: block; padding-top: 4px; font-size: 12px; color: var(--muted); }
.swatch { display: inline-block; width: 10px; height: 10px; border-radius: 3px; margin-right: 6px; }
.k-brick { background: #FF6B3D; } .k-single { background: #FFD23F; }
.k-hammer { background: #1F4FB8; } .k-shield { background: #7FD6AE; }
.bar { height: 14px; border-radius: 999px; overflow: hidden; display: flex; background: var(--ground);
  min-width: 140px; }
.bar > span { display: block; height: 100%; }
.progress { height: 10px; border-radius: 999px; overflow: hidden; background: var(--ground); display: flex; }
.progress > span { display: block; background: #2BB673; }

/* Growth preview */
.grow-steps { display: flex; align-items: flex-end; gap: 14px; flex-wrap: wrap; }
.grow-step { display: flex; flex-direction: column; align-items: center; gap: 6px; font-size: 12px;
  font-weight: 600; }
.grow-box { display: block; border-radius: 6px; background: #3D7BFF; }
.soft { padding: 16px; border-radius: 14px; background: #F7F8FB; display: flex; flex-direction: column;
  gap: 12px; }

/* Review panel */
.changes { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.changes li { padding: 10px 12px; border-radius: 12px; background: #F2F6FF; display: flex;
  flex-direction: column; gap: 4px; }
.changes .what { font-size: 12px; font-weight: 700; color: var(--blue); }
.changes .fromto { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.changes s { color: var(--muted); }
.errors { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.errors li { padding: 10px 12px; border-radius: 12px; background: var(--red-soft); color: var(--red);
  font-size: 13px; font-weight: 600; }
.notice { padding: 10px 12px; border-radius: 12px; font-size: 13px; font-weight: 600; }
.notice.warn { background: var(--warn); color: var(--warn-ink); }
.notice.ok { background: var(--green-soft); color: var(--green); }
.notice.info { background: #F7F8FB; color: var(--ink-2); font-weight: 400; }
.notice.red { background: var(--red-soft); color: var(--red); }
.full { width: 100%; min-height: 48px; font-size: 15px; font-weight: 700; }
fieldset.plain { margin: 0; padding: 0; border: none; display: flex; flex-direction: column; gap: 8px; }
fieldset.plain legend { padding: 0 0 8px; }

/* Switches */
.switch { min-height: 44px; padding: 8px 12px; border-radius: 12px; border: 1px solid var(--field);
  background: var(--card); color: var(--ink); display: flex; align-items: center; gap: 12px;
  text-align: left; white-space: normal; }
.switch .track { width: 40px; height: 24px; border-radius: 999px; flex-shrink: 0; display: flex;
  align-items: center; padding: 2px; background: var(--field); justify-content: flex-start; }
.switch .track::after { content: ""; width: 20px; height: 20px; border-radius: 999px; background: #fff; }
.switch[aria-checked="true"] .track { background: var(--ink); justify-content: flex-end; }
.switch .lines { display: flex; flex-direction: column; gap: 2px; }
.switch .lines span { font-size: 12px; font-weight: 400; color: var(--muted); }

/* Lists with a detail pane */
.picks { list-style: none; margin: 0; padding: 0; }
.picks li + li { border-top: 1px solid var(--line); }
.pick { width: 100%; min-height: 64px; padding: 12px 20px; border: none; border-radius: 0;
  background: var(--card); color: var(--ink); display: flex; align-items: center; gap: 14px;
  text-align: left; white-space: normal; }
.pick:hover { background: #F7F8FB; }
.pick[aria-pressed="true"] { background: #F2F6FF; box-shadow: inset 4px 0 0 #3D7BFF; }
.pick .lines { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.pick .lines span { font-size: 12px; font-weight: 400; color: var(--muted); }
.stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 10px; }
.stat { padding: 12px; border-radius: 12px; background: #F7F8FB; display: flex; flex-direction: column;
  gap: 2px; }
.stat span { font-size: 12px; color: var(--muted); }
.stat strong { font: 600 20px/1.2 var(--display); overflow-wrap: anywhere; }
.box { padding: 16px; border-radius: 14px; border: 1px solid #E3E6EE; display: flex;
  flex-direction: column; gap: 12px; }
.history { list-style: none; margin: 0; padding: 0; }
.history li { padding: 10px 0; border-top: 1px solid var(--line); display: flex; gap: 12px;
  flex-wrap: wrap; font-size: 14px; }
.history .when { width: 110px; flex-shrink: 0; color: var(--muted); }

/* Attention list on the overview */
.todo { list-style: none; margin: 0; padding: 0; }
.todo li { padding: 14px 20px; border-top: 1px solid var(--line); display: flex; align-items: center;
  gap: 14px; flex-wrap: wrap; }
.todo .kind { flex-shrink: 0; width: 84px; text-align: center; }
.todo .lines { flex: 1 1 260px; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.todo .lines span { font-size: 13px; color: var(--muted); }
.card.emergency { border: 2px solid #F3C3CC; }
a.button { display: inline-flex; align-items: center; min-height: 36px; padding: 0 12px;
  border-radius: 10px; border: 1px solid var(--field); font-size: 13px; font-weight: 600;
  text-decoration: none; background: var(--card); white-space: nowrap; }
a.button:hover { border-color: var(--ink); }

/* Mini-map of the selected area and the locks */
.minimap { position: relative; width: 100%; max-width: 420px; aspect-ratio: 1 / 1; border-radius: 14px;
  overflow: hidden; background-color: #F7F8FB;
  background-image: linear-gradient(#E3E6EE 1px, transparent 1px),
    linear-gradient(90deg, #E3E6EE 1px, transparent 1px);
  background-size: 6.25% 6.25%; }
.minimap .mark { position: absolute; box-sizing: border-box; border-radius: 2px; min-width: 6px;
  min-height: 6px; }
.minimap .open { border: 2px dashed #8C94A8; }
.minimap .lock { border: 2px solid var(--red-line);
  background: repeating-linear-gradient(45deg, rgba(177, 62, 83, 0.35) 0 3px, transparent 3px 6px); }
.minimap .sel { border: 2px solid var(--blue); background: rgba(61, 123, 255, 0.25); }
.area4 { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; }
.two { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }

/* Season timeline */
.timeline { list-style: none; margin: 0; padding: 0; display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 12px; }
.season-card { width: 100%; min-height: 96px; padding: 14px 16px; border-radius: 16px;
  border: 1px solid #E3E6EE; background: var(--card); color: var(--ink); display: flex;
  flex-direction: column; align-items: flex-start; gap: 6px; text-align: left; white-space: normal; }
.season-card .head { display: flex; align-items: center; justify-content: space-between; gap: 8px;
  width: 100%; }
.season-card strong { font: 700 20px/1.2 var(--display); }
.season-card[aria-pressed="true"] { border: 2px solid var(--ink); background: #F7F8FB; }

/* Sponsors */
.mark-logo { flex-shrink: 0; width: 52px; height: 34px; border-radius: 8px; display: inline-flex;
  align-items: center; justify-content: center; overflow: hidden; background: var(--ground);
  font-size: 12px; font-weight: 800; color: var(--ink-2); }
.mark-logo img { max-width: 100%; max-height: 100%; object-fit: contain; }
.mark-logo.big { width: 96px; height: 64px; }
.mark-logo.none { background: var(--card); border: 1.5px dashed var(--red-line); color: var(--red); }
.preview-col { flex: 1 1 300px; max-width: 360px; padding: 16px; border-radius: 16px; background: #F7F8FB;
  border: 1px dashed var(--field); display: flex; flex-direction: column; gap: 10px; }
.preview-col .caps { font-size: 11px; font-weight: 700; letter-spacing: 0.08em;
  text-transform: uppercase; color: var(--muted); }
.shown { display: flex; gap: 8px; flex-wrap: wrap; }
.shown-one { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-radius: 12px;
  background: var(--card); border: 1px solid #E3E6EE; font-size: 12px; font-weight: 700; }
.shown-one.featured { flex-basis: 100%; border: 2px solid var(--ink); }
.drop { flex: 1 1 180px; min-height: 64px; padding: 10px 14px; border-radius: 12px;
  border: 1.5px dashed #8C94A8; background: #F7F8FB; color: var(--ink); text-align: left;
  white-space: normal; }
.drop.over { border-color: var(--blue); background: #F2F6FF; }
.featured-btn[aria-pressed="true"] { border-color: var(--accent); background: var(--accent); color: var(--ink); }
tr.on td { background: #F2F6FF; }
.nowrap { white-space: nowrap; overflow-wrap: normal; }
.order { display: flex; gap: 4px; }
.order button { width: 36px; padding: 0; }

/* Audit */
.audit-row { width: 100%; min-height: 56px; padding: 12px 20px; border: none; border-radius: 0;
  background: var(--card); color: var(--ink); display: flex; align-items: center; gap: 14px;
  flex-wrap: wrap; text-align: left; white-space: normal; }
.audit-row:hover { background: #F7F8FB; }
.audit-row .when { width: 110px; flex-shrink: 0; font-size: 13px; color: var(--muted); }
.audit-row .group { width: 92px; flex-shrink: 0; }
.audit-row .lines { flex: 1 1 280px; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.audit-row .lines span { font-size: 12px; color: var(--muted); }
.audit-diff { padding: 0 20px 16px 250px; overflow-x: auto; }
.audit-diff table { width: auto; min-width: 320px; font-size: 13px; }
.audit-diff td { border-top: 1px solid var(--line); padding: 6px 16px 6px 0; vertical-align: top;
  overflow-wrap: anywhere; max-width: 420px; }
.audit-diff td:first-child { padding-left: 0; font-weight: 600; }
.audit-diff .before { color: var(--red); }
.audit-diff .after { color: var(--green); font-weight: 600; }

@media (max-width: 860px) {
  .nav-group { display: none; }
  .tabs { padding: 0 16px; overflow-x: auto; }
  .panel { padding: 16px; }
  .audit-diff { padding: 0 16px 16px; }
  .pick, .todo li, .audit-row { padding-left: 16px; padding-right: 16px; }
  body { display: block; }
  .side { position: static; height: auto; padding: 12px 16px; gap: 8px; }
  .brand { padding: 0; }
  .nav { flex-direction: row; overflow-x: auto; gap: 4px; padding-bottom: 4px; }
  .nav a { flex: 0 0 auto; padding: 8px 10px; }
  .who { margin: 0; padding: 0; }
  .env { padding: 8px 16px; }
  .content { padding: 20px 16px 48px; }
  .top h1 { font-size: 28px; }
  .card-head { padding: 16px; }
  .card-body { padding: 0 16px 16px; }
  th:first-child, td:first-child { padding-left: 16px; }
  th:last-child, td:last-child { padding-right: 16px; }
}
`;

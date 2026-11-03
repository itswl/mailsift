/**
 * The stylesheet of the browser view.
 *
 * Shipped inline in the page rather than as a file, so the runtime serves no
 * static assets and the view arrives in one response. Message content never
 * appears here; this is only how the shell and the rows look.
 *
 * The design in one paragraph: a single hairline-separated list of
 * judgements, grouped by day, set straight on the page background. Importance
 * is carried by a small mark, a word and weight; indigo means interactive and
 * nothing else; the only raised surfaces are the things that float (the
 * sheet, the filter popover, the toast). System fonts only, monospace only
 * for verification codes, and motion only where it reports something.
 */

/** Dark tokens adapted from QuotaPulse's neutral surfaces and indigo accent. */
const DARK_PALETTE = '--bg:#0e1013;--surface:#16191e;--fill:#1e2229;--fill-2:#262b33;--line:#262b33;--line-strong:#3a414d;'
  + '--text:#e9ebef;--text-2:#b4bac5;--muted:#8b95a3;--accent:#7b98f7;--on-accent:#0e1013;--accent-tint:#252c40;'
  + '--critical:#ef6b6b;--critical-text:#ef6b6b;--warning:#e8a33d;--warning-text:#e8a33d;'
  + '--backdrop:rgba(0,0,0,.5);--shadow-sheet:0 -8px 32px rgba(0,0,0,.5);--shadow-pop:0 8px 24px rgba(0,0,0,.45),0 0 0 1px var(--line);'
  + '--seg-on:#363d49;--switch-off:#6b7482;color-scheme:dark';
export const LIGHT_BAR = '#f4f5f7';

const SANS = '-apple-system,BlinkMacSystemFont,"SF Pro Text","PingFang SC","Segoe UI",Roboto,"Noto Sans CJK SC","Microsoft YaHei",sans-serif';
const MONO = 'ui-monospace,"SF Mono",Menlo,Consolas,"Roboto Mono",monospace';

export function styles(): string {
  return `
:root{color-scheme:light;--bg:#f4f5f7;--surface:#fff;--fill:#eceef2;--fill-2:#e3e5ea;--line:#e2e4e9;--line-strong:#c3c8d1;
--text:#15171b;--text-2:#4a505c;--muted:#5a616c;--accent:#3358d4;--on-accent:#fff;--accent-tint:#e1e5f4;
--critical:#d64545;--critical-text:#b03030;--warning:#b86b04;--warning-text:#8c5204;
--backdrop:rgba(21,23,27,.32);--shadow-sheet:0 -8px 32px rgba(21,23,27,.12);--shadow-pop:0 8px 24px rgba(21,23,27,.10);
--seg-on:#fff;--switch-off:#868e9b}
:root[data-theme=dark]{` + DARK_PALETTE + `}
*{box-sizing:border-box}
html{touch-action:manipulation;background:var(--bg)}
button,input,select,textarea,a{-webkit-tap-highlight-color:transparent}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.45 ` + SANS + `;
padding:0 env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);-webkit-text-size-adjust:100%;overscroll-behavior-y:contain}
/* CJK is never tracked and wants more leading; headings stay at 600 because PingFang's bold is heavy. */
html[lang=zh-CN] body{line-height:1.6}
html[lang=zh-CN] .lede,html[lang=zh-CN] .brand strong,html[lang=zh-CN] .login h1,html[lang=zh-CN] .day{letter-spacing:0}
/* Paint the area behind the iOS status bar from the live theme, not the
   theme-color snapshot iOS took when this home-screen app was opened. */
body::before{content:"";position:fixed;inset:0 0 auto;height:env(safe-area-inset-top);background:var(--bg);z-index:4;pointer-events:none}
[hidden]{display:none!important}
.sr-only{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
::selection{background:var(--accent-tint)}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
/* A heading focused so a screen reader starts there is not a control: no ring. */
[tabindex="-1"]:focus{outline:none}
.icon{display:inline-block;width:1em;height:1em;fill:none;stroke:currentColor;stroke-width:1.75;stroke-linecap:round;stroke-linejoin:round;vertical-align:-.15em}

/* ---- Header ---- */
.app-header{position:sticky;top:0;z-index:5;padding:env(safe-area-inset-top) 12px 0 16px;background:var(--bg);border-bottom:1px solid transparent;transition:border-color .12s}
.app-header.scrolled{border-bottom-color:var(--line)}
.header-inner{display:flex;align-items:center;justify-content:space-between;gap:12px;width:min(1200px,100%);min-height:52px;margin:0 auto}
.brand,.header-actions{display:flex;align-items:center}
.brand{gap:8px}
.brand strong{font-size:16px;font-weight:600;letter-spacing:-.02em}
.brand-mark{display:block;width:24px;height:24px;border-radius:7px;object-fit:cover}
.icon-btn,.word-btn{min-width:44px;min-height:44px;padding:0 8px;border:0;border-radius:10px;background:transparent;color:var(--muted);font:inherit;font-size:13px;font-weight:600;cursor:pointer;display:grid;place-items:center;transition:background .12s,color .12s}
.icon-btn svg{display:block;width:20px;height:20px;fill:none;stroke:currentColor;stroke-width:1.75;stroke-linecap:round;stroke-linejoin:round}
.theme-icon{transition:transform .45s cubic-bezier(.2,.7,.2,1)}:root[data-theme=dark] .theme-icon{transform:rotate(180deg)}
#refresh:disabled{cursor:wait;color:var(--accent)}#refresh.running .refresh-icon{animation:spin .9s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}
#install{color:var(--accent);display:none}

/* ---- Page ---- */
.app-main{width:min(1200px,100%);margin:0 auto;padding:8px 0 24px}
.feed{min-width:0}
.version{color:var(--muted);font-size:11px;font-weight:400;white-space:nowrap}
footer.version{text-align:center;padding:8px 14px 20px}.login .version{text-align:center;margin:14px 0 0}
.text-btn{appearance:none;border:0;background:none;color:var(--accent);font:inherit;font-size:13px;font-weight:600;padding:12px 8px;min-height:44px;border-radius:8px;cursor:pointer;white-space:nowrap}
.text-btn:disabled{opacity:.5;cursor:default}
.text-btn.quiet{color:var(--muted)}
.primary-action{min-height:44px;padding:8px 16px;border:0;border-radius:10px;background:var(--accent);color:var(--on-accent);font:inherit;font-weight:600;cursor:pointer}

/* ---- Title block: the sentence and the status line ---- */
.banner{display:flex;align-items:center;gap:8px;margin:8px 16px 0;padding:6px 4px 6px 12px;border-left:2px solid var(--critical-text);font-size:13px;color:var(--text)}
.banner.offline{border-left-color:var(--warning-text)}
.banner span{flex:1;min-width:0}
.title{padding:16px 16px 4px}
.lede{margin:0;font-size:22px;line-height:1.25;font-weight:600;letter-spacing:-.02em;min-height:1.25em;font-variant-numeric:tabular-nums;transition:opacity .24s}
.lede.pending{color:var(--muted);font-weight:500}
.glue{white-space:nowrap}
.num{appearance:none;border:0;padding:0;margin:0;background:none;color:inherit;font:inherit;cursor:pointer;border-radius:4px;
text-decoration:underline;text-decoration-thickness:1px;text-underline-offset:.16em;text-decoration-color:var(--line-strong);transition:color .12s,text-decoration-color .12s}
.num:focus-visible{color:var(--accent);text-decoration-color:var(--accent)}
.status{margin:6px 0 0;min-height:1.4em;font-size:13px;color:var(--muted);font-variant-numeric:tabular-nums;transition:color .2s}
.status.warn{color:var(--warning-text)}
/* A mailbox the poller cannot read: named under the status, and a way in to the fix. */
.health-line{display:inline-flex;align-items:center;gap:2px;margin:2px 0 0;padding:6px 0;min-height:32px;border:0;background:none;
color:var(--warning-text);font:inherit;font-size:13px;font-weight:500;text-align:left;cursor:pointer}
.health-line .icon{width:14px;height:14px}

/* ---- Controls ---- */
.controls{margin:6px 0 0}
.control-line{display:flex;align-items:center;gap:2px;padding:0 6px 0 8px;min-height:44px}
.window{display:flex;gap:0;flex:1;min-width:0;margin:0;padding:0;border:0}
.seg{position:relative;display:block;padding:12px 8px;font-size:13px;font-weight:500;color:var(--muted);cursor:pointer;border-radius:8px;font-variant-numeric:tabular-nums}
.seg input{position:absolute;inset:0;margin:0;opacity:0;cursor:pointer}
.seg span{position:relative;display:block;padding-bottom:2px;border-bottom:2px solid transparent;white-space:nowrap;transition:border-color .2s,color .12s}
.seg.on{color:var(--text)}.seg.on span{font-weight:600;border-bottom-color:var(--accent)}
.seg input:focus-visible+span{outline:2px solid var(--accent);outline-offset:3px;border-radius:4px}
.search-line{display:flex;align-items:center;gap:2px;padding:4px 6px 4px 16px}
.search-field{position:relative;flex:1;min-width:0}
.search-field .icon{position:absolute;left:10px;top:50%;width:16px;height:16px;margin-top:-8px;color:var(--muted);pointer-events:none}
.search-field input{width:100%;min-height:36px;border:0;border-radius:10px;background:var(--fill);color:var(--text);padding:6px 10px 6px 32px;font:inherit;font-size:16px}
.search-field input::placeholder{color:var(--muted)}
input[type=search]::-webkit-search-cancel-button{-webkit-appearance:none}
.tokens{display:flex;flex-wrap:wrap;gap:0 2px;padding:0 10px}
.token{appearance:none;border:0;background:none;color:var(--text);font:inherit;font-size:13px;font-weight:500;padding:8px;min-height:36px;border-radius:8px;cursor:pointer}
.token::after{content:" ×";color:var(--muted)}
.token.clear{color:var(--muted)}.token.clear::after{content:none}

/* ---- Sheets: the detail on a phone, filters, the install steps ---- */
.sheet{position:fixed;inset:auto 0 0 0;z-index:20;width:100%;max-width:640px;margin:0 auto;border:0;padding:0;background:var(--surface);color:var(--text);
border-radius:16px 16px 0 0;box-shadow:var(--shadow-sheet);max-height:calc(100vh - env(safe-area-inset-top) - 8px);max-height:calc(100dvh - env(safe-area-inset-top) - 8px);
overflow:hidden;flex-direction:column;transition:transform .2s cubic-bezier(.2,.7,.2,1)}
.sheet[open]{display:flex}
.sheet::backdrop{background:var(--backdrop);animation:fade .24s}
#sheet{height:calc(100vh - env(safe-area-inset-top) - 8px);height:calc(100dvh - env(safe-area-inset-top) - 8px)}
.sheet.opening{animation:sheet-in .32s cubic-bezier(.2,.7,.2,1)}
.sheet.closing{animation:sheet-out .24s cubic-bezier(.4,0,1,1) forwards}
@keyframes sheet-in{from{transform:translateY(100%)}}@keyframes sheet-out{to{transform:translateY(100%)}}@keyframes fade{from{opacity:0}}
.sheet-head{position:relative;flex:none;display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:52px;padding:14px 8px 0 16px;touch-action:none;user-select:none;-webkit-user-select:none}
.sheet-head h2{margin:0;font-size:15px;font-weight:600;flex:1;text-align:center}
.handle{position:absolute;left:50%;top:8px;width:36px;height:4px;margin-left:-18px;border-radius:2px;background:var(--line-strong)}
.sheet-body{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain;-webkit-overflow-scrolling:touch;padding:0 16px calc(24px + env(safe-area-inset-bottom))}
#filter-sheet .sheet-body,#health-sheet .sheet-body{padding-bottom:calc(16px + env(safe-area-inset-bottom))}
.mailbox{padding:12px 0;border-top:1px solid var(--line)}
.mailbox:first-child{border-top:0}
.mailbox-head{display:flex;align-items:baseline;gap:4px 8px;flex-wrap:wrap}
.mailbox-head .mark{margin:0;align-self:center}
.mailbox-address{font-size:12px;color:var(--muted);overflow-wrap:anywhere}
.mailbox-state{margin:4px 0 0 16px;font-size:13px;color:var(--muted)}
.mailbox.failing .mailbox-state{color:var(--critical-text)}
.mailbox-fix{margin:6px 0 0 16px;font-size:13px;line-height:1.5}
.mailbox-command{display:flex;align-items:center;gap:4px;margin:8px 0 0 16px;padding:6px 4px 6px 10px;border-radius:10px;background:var(--fill)}
.mailbox-command code{flex:1;min-width:0;font:12px/1.5 ` + MONO + `;overflow-wrap:anywhere;user-select:all;-webkit-user-select:all}
.mailbox-outbox{margin:12px 0 0;font-size:13px;color:var(--muted)}
.field{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:52px;padding:6px 0;border-top:1px solid var(--line)}
.field:first-child{border-top:0}
.label{font-size:13px;color:var(--muted);flex:none}
.segset{display:flex;gap:2px;flex:1;max-width:320px;margin:0;padding:2px;border:0;border-radius:10px;background:var(--fill);min-width:0}
.segset .seg{flex:1;padding:6px 6px;text-align:center;border-radius:8px;color:var(--muted)}
.segset .seg span{border:0;padding:0;font-size:13px;overflow:hidden;text-overflow:ellipsis}
.segset .seg.on{background:var(--seg-on);color:var(--text);box-shadow:0 1px 2px rgba(0,0,0,.08)}
.pick{position:relative;cursor:pointer}
.pick select{appearance:none;-webkit-appearance:none;flex:1;min-width:0;border:0;background:transparent;color:var(--text);font:inherit;font-size:16px;text-align:right;text-align-last:right;padding:6px 22px 6px 0;cursor:pointer}
.pick .icon{position:absolute;right:0;top:50%;width:16px;height:16px;margin-top:-8px;color:var(--line-strong);pointer-events:none}
.switch{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:52px;border-top:1px solid var(--line);font-size:15px;cursor:pointer}
.switch input{appearance:none;-webkit-appearance:none;position:relative;flex:none;width:36px;height:20px;margin:0;border-radius:10px;background:var(--switch-off);cursor:pointer;transition:background .12s}
.switch input::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.2);transition:transform .2s cubic-bezier(.2,.7,.2,1)}
.switch input:checked{background:var(--accent)}.switch input:checked::after{transform:translateX(16px)}

/* ---- The fresh-code lane ---- */
.lane{margin:8px 16px 4px}
.lane-copy{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:6px 12px;width:100%;margin:0;padding:14px 16px;border:0;border-radius:12px;background:var(--fill);color:var(--text);font:inherit;text-align:left;cursor:pointer}
.lane-copy:active{background:var(--fill-2)}
.lane-wait{display:flex;align-items:center;min-height:64px;padding:14px 16px;border-radius:12px;background:var(--fill)}
.lane-wait .eyebrow{font-size:13px;color:var(--muted);display:inline-flex;align-items:center;gap:8px}
.lane-wait .eyebrow::before{content:"";width:6px;height:6px;border-radius:50%;background:var(--accent);animation:breathe 1.8s ease-in-out infinite}
@keyframes breathe{50%{opacity:.25}}
.lane-copy .eyebrow{grid-column:1/-1;font-size:13px;color:var(--muted)}
.digits{font:600 28px/1 ` + MONO + `;letter-spacing:.14em;font-variant-numeric:tabular-nums slashed-zero;user-select:all;-webkit-user-select:all;white-space:nowrap}
.digits span+span{margin-left:.35em}
.verb{display:inline-flex;align-items:center;gap:4px;font-size:15px;font-weight:600;color:var(--accent);white-space:nowrap}
.verb .icon{width:14px;height:14px;stroke-dasharray:24;stroke-dashoffset:24;animation:draw .16s ease-out forwards}
.verb.selected{color:var(--muted);font-weight:500}

/* ---- The feed ---- */
#list{padding:0 0 4px}
.day{position:sticky;top:calc(52px + env(safe-area-inset-top));z-index:3;display:flex;justify-content:space-between;align-items:baseline;margin:0;padding:14px 16px 4px;background:var(--bg);font-size:12px;font-weight:600;color:var(--muted);letter-spacing:.02em}
.day .count{font-weight:500;font-variant-numeric:tabular-nums}
.group{list-style:none;margin:0;padding:0}
.row{position:relative;display:grid;grid-template-columns:20px minmax(0,1fr) auto;grid-template-areas:"mark who when" "mark sum sum" "mark meta meta" "mark why why";row-gap:2px;padding:12px 16px;min-height:60px;border-top:1px solid var(--line);scroll-margin-top:calc(92px + env(safe-area-inset-top))}
.group .row:first-child{border-top:0}
.row:active{background:var(--fill-2)}
@media(hover:hover){
  .row:hover,.text-btn:hover,.token:hover,.actions a:hover{background:var(--fill)}
  button.digest-item:hover .gist,.health-line:hover{text-decoration:underline;text-decoration-color:var(--line-strong)}
  .icon-btn:hover,.word-btn:hover{background:var(--fill);color:var(--text)}
  .num:hover{color:var(--accent);text-decoration-color:var(--accent)}
  .token.clear:hover,.text-btn.quiet:hover,.login .lang:hover{color:var(--text)}
}
.row.selected{background:var(--surface)}
.mark{grid-area:mark;width:8px;height:8px;margin-top:7px;border-radius:50%;background:var(--critical)}
.mark.warning{background:var(--warning)}.mark.info{background:transparent;box-shadow:inset 0 0 0 1.5px var(--line-strong)}
.who{grid-area:who;min-width:0;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:inherit;text-decoration:none}
/* The sender is the link, stretched over the whole row; the copy button sits above it. */
.who::after{content:"";position:absolute;inset:0}
.who:focus-visible{outline:none}.who:focus-visible::after{outline:2px solid var(--accent);outline-offset:-2px;border-radius:6px}
.when{grid-area:when;margin-left:8px;font-size:12px;color:var(--muted);font-variant-numeric:tabular-nums;white-space:nowrap}
.sum{grid-area:sum;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:3;overflow:hidden}
.row.info .sum{color:var(--text-2);-webkit-line-clamp:2}
.meta{grid-area:meta;font-size:12px;color:var(--muted)}
.lvl{font-weight:500}.lvl.critical{color:var(--critical-text)}.lvl.warning{color:var(--warning-text)}
.due{color:var(--warning-text);font-weight:500}.rescued{color:var(--text);font-weight:500}
.why{grid-area:why;font-size:13px;color:var(--muted);display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden}
.row:not(.critical) .why{display:none}
.row,.detail,.lane,.digest{overflow-wrap:anywhere;min-width:0}
.code-copy{grid-area:sum;position:relative;z-index:1;display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:44px;margin:0;padding:0;border:0;border-radius:8px;background:none;color:var(--text);font:inherit;text-align:left;cursor:pointer}
.code-copy .digits{font-size:22px}.code-copy .verb{font-size:13px}
.row.stale .digits{color:var(--muted)}
.row.arrived,.lane-copy.arrived{animation:arrive 1.2s ease-out}@keyframes arrive{from{background:var(--accent-tint)}}
.since{display:flex;align-items:center;gap:10px;padding:8px 16px 2px;font-size:12px;font-weight:500;color:var(--accent)}
.since::before,.since::after{content:"";flex:1;height:1px;background:var(--accent);opacity:.35}
.load-more{display:block;margin:4px auto 0;color:var(--accent)}
body.offline #refresh,body.offline .load-more{opacity:.4;pointer-events:none}
.load-more.failed{color:var(--critical-text)}
.install-line{display:flex;align-items:center;flex-wrap:wrap;gap:0 2px;padding:8px 8px 8px 16px;font-size:13px;color:var(--muted)}
.install-line span{flex:1 1 220px}
.empty{padding:40px 16px 24px;text-align:center;color:var(--muted)}
.empty .envelope{display:block;width:56px;height:56px;margin:0 auto 12px;color:var(--line-strong);fill:none;stroke:currentColor;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}
.empty .envelope path{stroke-dasharray:420;stroke-dashoffset:420;animation:draw .6s ease-out forwards}
@keyframes draw{to{stroke-dashoffset:0}}
.empty h3{margin:0 0 6px;font-size:17px;font-weight:600;color:var(--text)}
.empty p{margin:0 0 4px;font-size:13px}

/* ---- Detail: the same content in the sheet and in the desktop pane ---- */
.detail{padding:4px 0 8px}
.detail h3{margin:0 0 6px;font-size:18px;line-height:1.3;font-weight:600;overflow-wrap:anywhere}
.code-band{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:6px 12px;width:calc(100% + 32px);margin:0 -16px 14px;padding:16px;border:0;background:var(--fill);color:var(--text);font:inherit;text-align:left;cursor:pointer}
.code-band .digits{font-size:32px}
.code-band .caption{grid-column:1/-1;font-size:13px;color:var(--muted)}
.byline{margin:0 0 12px;font-size:13px;color:var(--muted)}
.judgement{display:grid;gap:4px;margin:0 0 12px;padding:10px 12px;border-radius:12px;background:var(--fill);font-size:13px}
.judgement .line{display:flex;align-items:center;gap:8px;color:var(--text);font-weight:500}
.judgement .mark{margin:0;flex:none}
.detail dl{margin:0;display:grid;grid-template-columns:auto 1fr;gap:2px 10px;font-size:13px}
.detail dt{color:var(--muted)}
/* A dd carries a 40px inline start margin by default, which pushes the value
   out of its grid column. */
.detail dd{margin:0}
.summary{margin:0 0 8px;white-space:pre-wrap;line-height:1.55}
.actions{display:flex;flex-wrap:wrap;gap:0 2px;margin:0 -8px 6px}
.actions a{display:inline-flex;align-items:center;gap:4px;padding:12px 8px;min-height:44px;border-radius:8px;color:var(--accent);font-size:13px;font-weight:600;text-decoration:none}
.section-label{margin:14px 0 4px;font-size:12px;font-weight:600;color:var(--muted);letter-spacing:.02em}
.live-body{margin:4px 0 0;white-space:pre-wrap;word-break:break-word;font:inherit;line-height:1.6}
.live-body.pending,.inline-status{color:var(--muted);font-size:13px}
.inline-error{color:var(--critical-text);font-size:13px}
.disclosure{display:flex;align-items:center;justify-content:space-between;gap:8px;width:100%;min-height:48px;margin:0;padding:0;border:0;border-top:1px solid var(--line);background:none;color:var(--text);font:inherit;font-size:15px;font-weight:500;text-align:left;cursor:pointer}
.disclosure .icon{width:16px;height:16px;color:var(--line-strong);transition:transform .2s}
.disclosure[aria-expanded=true] .icon{transform:rotate(90deg)}
.disclosure-body{padding:2px 0 12px;font-size:13px}
.attachment-list{list-style:none;margin:0;padding:0;display:grid;gap:8px}
.attachment-item{display:flex;gap:4px 10px;align-items:baseline;flex-wrap:wrap}
.attachment-item a{color:var(--accent);font-weight:500;overflow-wrap:anywhere}
.attachment-item .text-btn{padding:4px 8px;min-height:28px;font-size:12px}
.attachment-scan{flex-basis:100%}
.attachment-meta,.attachment-status,.safety-meta,.safety-status{color:var(--muted);font-size:12px}
.attachment-status,.safety-status{margin:4px 0 0}
.safety-findings{list-style:none;margin:4px 0;padding:0;display:grid;gap:6px}
.safety-finding{position:relative;padding-left:14px}
.safety-finding::before{content:"";position:absolute;left:0;top:.5em;width:6px;height:6px;border-radius:50%;background:var(--line-strong)}
.safety-finding.warning::before,.safety-warning{color:var(--critical-text)}.safety-finding.warning::before{background:var(--critical-text)}
.safety-finding.caution::before{background:var(--warning-text)}
.safety-warning{font-size:12px}
.thread-history{margin-top:8px;border-top:1px solid var(--line);padding-top:4px}
.timeline{list-style:none;margin:0;padding:0 0 0 14px;border-left:1px solid var(--line)}
.timeline li{position:relative;padding:6px 0 10px;font-size:13px}
.timeline li::before{content:"";position:absolute;left:-17.5px;top:12px;width:6px;height:6px;border-radius:50%;background:var(--line-strong)}
.timeline .tl-head{color:var(--muted)}
.timeline .tl-subject{font-weight:500;margin:1px 0}
.timeline .tl-sum{color:var(--text-2);display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden}

/* ---- Digest ---- */
.digest{margin:20px 16px 0;padding-top:14px;border-top:1px solid var(--line)}
.digest h2{margin:0;font-size:15px;font-weight:600}
.digest-meta{margin:2px 0 6px;font-size:13px;color:var(--muted)}
.digest-group{margin:10px 0 0}
.digest-group h4{margin:0 0 2px;font-size:12px;font-weight:600;color:var(--muted)}.digest-group h4.spam{color:var(--warning-text)}
.digest-item{display:block;width:100%;margin:0;padding:3px 0;border:0;background:none;color:inherit;font:inherit;font-size:14px;line-height:1.45;text-align:left}
button.digest-item{cursor:pointer;border-radius:6px}
.digest-line{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden}
.digest-sent{margin-top:14px;padding-top:6px;border-top:1px solid var(--line)}
.digest > .digest-sent:first-child{margin-top:0;padding-top:0;border-top:0}
.digest-sent-head{display:flex;align-items:baseline;gap:8px;width:100%;margin:0;padding:8px 0;border:0;background:none;color:var(--text);font:inherit;text-align:left;cursor:pointer}
.digest-sent-title{font-size:15px;font-weight:600;flex:none}
.digest-sent-head .digest-meta{margin:0;flex:1;min-width:0}
.digest-sent-head .icon{width:16px;height:16px;flex:none;align-self:center;color:var(--line-strong);transition:transform .2s}
.digest-sent-head[aria-expanded=true] .icon{transform:rotate(90deg)}
.digest-item b{font-weight:500}.digest-item .gist{color:var(--text-2)}
.digest-fallback{white-space:pre-wrap;font-size:13px;color:var(--muted)}

/* ---- Toast (failures only) ---- */
.toast{position:fixed;left:50%;bottom:calc(16px + env(safe-area-inset-bottom));transform:translateX(-50%);z-index:9;max-width:min(360px,calc(100vw - 32px));padding:10px 14px;border:1px solid var(--line);border-radius:10px;background:var(--surface);color:var(--text);box-shadow:var(--shadow-pop);font-size:13px;animation:toast-in .18s ease-out}
.toast.failed{color:var(--critical-text)}
@keyframes toast-in{from{opacity:0;transform:translate(-50%,6px)}}

/* ---- Install steps ---- */
.steps{list-style:none;margin:4px 0 12px;padding:0;display:grid;gap:10px}
.steps li{display:flex;align-items:center;gap:12px;font-size:15px}
.steps .icon{width:20px;height:20px;color:var(--accent);flex:none}
.install-help .muted{margin:0 0 16px;font-size:13px;color:var(--muted)}

/* ---- Desktop: a pane beside the list ---- */
.pane{display:none}
@media(min-width:900px){
  .app-header{padding-left:24px;padding-right:20px}.header-inner{min-height:56px}
  #install{display:grid}.install-line{display:none}
  .app-main{display:grid;grid-template-columns:minmax(0,1fr) 420px;gap:32px;padding:12px 24px 40px;align-items:start}
  .title,.day,.row,.lane,.digest,.since{padding-left:12px;padding-right:12px}
  .lane,.digest{margin-left:0;margin-right:0}
  .banner{margin:8px 12px 0}
  .control-line{padding-left:4px}.search-line{padding-left:12px;padding-right:12px}.tokens{padding:0 4px}
  #search-open,#search-cancel{display:none}.search-line[hidden]{display:flex!important}
  .lede{font-size:24px}
  .day{top:calc(56px + env(safe-area-inset-top))}
  .row{scroll-margin-top:calc(96px + env(safe-area-inset-top))}
  .pane{display:block;position:sticky;top:calc(68px + env(safe-area-inset-top));max-height:calc(100vh - 84px - env(safe-area-inset-top));overflow:auto;overscroll-behavior:contain;border-radius:16px;background:var(--surface);box-shadow:0 0 0 1px var(--line)}
  .pane-head{display:flex;justify-content:flex-end;align-items:center;min-height:44px;padding:4px 8px 0}
  .pane-body{padding:0 20px 20px}
  .pane-body .code-band{width:calc(100% + 40px);margin-left:-20px;margin-right:-20px}
  .pane-empty{display:grid;place-items:center;gap:6px;min-height:220px;padding:24px;text-align:center;color:var(--muted)}
  .pane-empty .keys{font-size:12px;color:var(--muted)}
  .pane-empty p{margin:0}
  .sheet.popover{position:absolute;inset:auto;left:var(--pop-left,auto);top:var(--pop-top,auto);width:320px;max-height:min(70vh,560px);border-radius:12px;border:1px solid var(--line);box-shadow:var(--shadow-pop);background:var(--surface)}
  .sheet.popover .handle{display:none}
  .sheet.popover .sheet-head{padding-top:4px;min-height:44px}
  .sheet.popover .sheet-body{padding-bottom:12px}
  .sheet.popover.opening,.sheet.popover.closing{animation:fade .12s}
  .sheet.popover::backdrop{background:transparent}
}
@media(min-width:1180px){
  .row{grid-template-columns:20px minmax(0,1fr) auto 200px;grid-template-areas:"mark who when why" "mark sum sum why" "mark meta meta why"}
  .row .why,.row:not(.critical) .why{display:-webkit-box;padding-left:16px;-webkit-line-clamp:3}
}

/* ---- Small phones and touch ---- */
@media(pointer:coarse){
  input:not([readonly]):not([type=checkbox]):not([type=radio]):not([type=hidden]):not([type=button]):not([type=submit]):not([type=reset]),textarea,select{font-size:16px}
}
@media(max-width:370px){
  .brand strong{display:none}
  .seg{padding-left:6px;padding-right:6px}
  .lane-copy{padding:12px 14px}.digits{font-size:24px}
}

/* ---- Sign-in ---- */
.login{max-width:320px;margin:18vh auto 0;padding:0 24px;display:flex;flex-direction:column;align-items:center;text-align:center}
.login .brand-mark{width:56px;height:56px;border-radius:16px;margin-bottom:14px}
.login h1{margin:0 0 6px;font-size:28px;font-weight:600;letter-spacing:-.02em}
.login .muted{margin:0 0 24px;color:var(--muted)}
.login input,.login button{width:100%;font:inherit}
/* Present so a password manager has an account to file the token under, but
   it is not a second thing to fill in. */
.login input[name=user]{border:0;background:none;color:var(--muted);font-size:13px;text-align:center;padding:4px;margin-bottom:4px;cursor:default}
.login input[name=token]{min-height:48px;border:0;border-radius:10px;background:var(--fill);color:var(--text);padding:10px 14px;font-size:16px}
.login input[name=token]::placeholder{color:var(--muted)}
.login button[type=submit]{min-height:48px;margin-top:12px;border:0;border-radius:10px;background:var(--accent);color:var(--on-accent);font-size:15px;font-weight:600;cursor:pointer}
.login .error{align-self:stretch;margin:12px 0 0;padding:4px 10px;border-left:2px solid var(--critical-text);color:var(--critical-text);font-size:13px;text-align:left}
/* On the sign-in form the switch is a quiet word under the button, not a second button. */
.login .lang{width:auto;margin:20px auto 0;padding:8px;border:0;background:none;color:var(--muted);font-size:13px;cursor:pointer}
@media(max-height:700px){.login{margin-top:12vh}}

/* ---- Motion off ---- */
@media(prefers-reduced-motion:reduce){
  *,*::before,*::after{animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:.01ms!important}
  .empty .envelope path{stroke-dashoffset:0}.verb .icon{stroke-dashoffset:0}
}
`;
}

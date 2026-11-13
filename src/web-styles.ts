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
 * nothing else; green means done or verified and nothing else; the only
 * raised surfaces are the things that float (the sheets, the popover, the
 * palette, the toast). System fonts only, monospace only for verification
 * codes, and motion only where it reports something.
 *
 * What needs the reader sits above everything else, and the mark that shows a
 * row's importance there is a ring that completes it. A message itself is
 * shown in a frame of its own, in the sender's design: the one place on the
 * page that is deliberately not styled here.
 */

/** Dark tokens adapted from QuotaPulse's neutral surfaces and indigo accent. */
const DARK_PALETTE = '--bg:#0e1013;--surface:#16191e;--fill:#1e2229;--fill-2:#262b33;--line:#262b33;--line-strong:#3a414d;'
  + '--text:#e9ebef;--text-2:#b4bac5;--muted:#8b95a3;--accent:#7b98f7;--on-accent:#0e1013;--accent-tint:#252c40;'
  + '--critical:#ef6b6b;--critical-text:#ef6b6b;--warning:#e8a33d;--warning-text:#e8a33d;'
  + '--backdrop:rgba(0,0,0,.5);--shadow-sheet:0 -8px 32px rgba(0,0,0,.5);--shadow-pop:0 8px 24px rgba(0,0,0,.45),0 0 0 1px var(--line);'
  + '--seg-on:#363d49;--switch-off:#6b7482;--ok:#56c48d;--ok-tint:#1b3126;color-scheme:dark';
export const LIGHT_BAR = '#f4f5f7';

const SANS = '-apple-system,BlinkMacSystemFont,"SF Pro Text","PingFang SC","Segoe UI",Roboto,"Noto Sans CJK SC","Microsoft YaHei",sans-serif';
const MONO = 'ui-monospace,"SF Mono",Menlo,Consolas,"Roboto Mono",monospace';

export function styles(): string {
  return `
:root{color-scheme:light;--bg:#f4f5f7;--surface:#fff;--fill:#eceef2;--fill-2:#e3e5ea;--line:#e2e4e9;--line-strong:#c3c8d1;
--text:#15171b;--text-2:#4a505c;--muted:#5a616c;--accent:#3358d4;--on-accent:#fff;--accent-tint:#e1e5f4;
--critical:#d64545;--critical-text:#b03030;--warning:#b86b04;--warning-text:#8c5204;
--backdrop:rgba(21,23,27,.32);--shadow-sheet:0 -8px 32px rgba(21,23,27,.12);--shadow-pop:0 8px 24px rgba(21,23,27,.10);
--seg-on:#fff;--switch-off:#868e9b;--ok:#1c7a4b;--ok-tint:#dcefe4}
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
.icon-btn .icon{vertical-align:0}
.theme-icon{transition:transform .45s cubic-bezier(.2,.7,.2,1)}:root[data-theme=dark] .theme-icon{transform:rotate(180deg)}
#bell{position:relative}#bell.on{color:var(--text)}#bell.on::after{content:"";position:absolute;top:11px;right:10px;width:7px;height:7px;border-radius:50%;background:var(--accent);box-shadow:0 0 0 2px var(--bg)}
.icon-btn:disabled{opacity:.3;cursor:default}.icon-btn.small{min-width:32px;min-height:32px;margin:-6px -6px -6px 0}.icon-btn.small svg,.icon-btn.small .icon{width:16px;height:16px}
#refresh:disabled{cursor:wait;color:var(--accent);opacity:1}#refresh.running .refresh-icon{animation:spin .9s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}

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
.tally{margin:4px 0 0;min-height:1.45em;font-size:15px;color:var(--text-2);font-variant-numeric:tabular-nums}
.glue{white-space:nowrap}
.num{appearance:none;border:0;padding:0;margin:0;background:none;color:inherit;font:inherit;cursor:pointer;border-radius:4px;
text-decoration:underline;text-decoration-thickness:1px;text-underline-offset:.16em;text-decoration-color:var(--line-strong);transition:color .12s,text-decoration-color .12s}
.num:focus-visible{color:var(--accent);text-decoration-color:var(--accent)}
.status{margin:6px 0 0;min-height:1.4em;font-size:13px;color:var(--muted);font-variant-numeric:tabular-nums;transition:color .2s}
.status.warn{color:var(--warning-text)}
.status.live::before{content:"";display:inline-block;width:6px;height:6px;margin-right:6px;border-radius:50%;background:var(--ok);vertical-align:1px}
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
.search-field input{width:100%;min-height:36px;border:0;border-radius:10px;background:var(--fill);color:var(--text);padding:6px 86px 6px 32px;font:inherit;font-size:16px}
.ask-btn{position:absolute;right:4px;top:50%;transform:translateY(-50%);display:inline-flex;align-items:center;gap:4px;height:28px;padding:0 10px;border:0;border-radius:7px;background:var(--accent);color:var(--on-accent);font:inherit;font-size:13px;font-weight:600;cursor:pointer;white-space:nowrap}
.ask-btn .icon{position:static;width:14px;height:14px;margin:0;color:inherit}
.kbd{display:inline-block;min-width:20px;padding:0 5px;border:1px solid var(--line-strong);border-bottom-width:2px;border-radius:5px;background:var(--surface);color:var(--muted);font:500 11px/1.6 inherit;font-family:inherit;text-align:center;white-space:nowrap}
.search-field .kbd{position:absolute;right:8px;top:50%;transform:translateY(-50%);pointer-events:none}.ask-btn:not([hidden])~.kbd{display:none}
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
.row{position:relative;display:grid;grid-template-columns:24px minmax(0,1fr) auto;grid-template-areas:"mark who when" "mark sum sum" "mark meta meta" "mark why why";row-gap:2px;padding:12px 16px;min-height:60px;border-top:1px solid var(--line);scroll-margin-top:calc(92px + env(safe-area-inset-top))}
.group .row:first-child{border-top:0}
.row:active{background:var(--fill-2)}
@media(hover:hover){
  .row:hover,.text-btn:hover,.token:hover,.actions a:hover,.bar-btn:hover,.menu-item:hover,.chip:hover{background:var(--fill)}
  .ring:hover{background:var(--ok-tint);border-color:var(--ok);color:var(--ok)}
  button.mark.done:hover{color:var(--muted)}
  .bar-btn.primary:hover{background:var(--accent);filter:brightness(1.08)}
  .source:hover .source-line,.tl-open:hover .tl-sum,.link-btn:hover{color:var(--text)}
  button.digest-item:hover .gist,.health-line:hover{text-decoration:underline;text-decoration-color:var(--line-strong)}
  .icon-btn:hover,.word-btn:hover{background:var(--fill);color:var(--text)}
  .num:hover{color:var(--accent);text-decoration-color:var(--accent)}
  .token.clear:hover,.text-btn.quiet:hover,.login .lang:hover{color:var(--text)}
}
.row.selected{background:var(--surface)}
.mark{grid-area:mark;width:8px;height:8px;margin:7px 0 0 4px;border-radius:50%;background:var(--critical)}
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
.due{color:var(--warning-text);font-weight:500}.due.late{color:var(--critical-text)}.rescued{color:var(--text);font-weight:500}
.why{grid-area:why;font-size:13px;color:var(--muted);display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden}
.row:not(.critical) .why{display:none}
mark{background:var(--accent-tint);color:inherit;border-radius:3px;padding:0 1px}
/* The ring: a row's importance, and the control that completes it. */
.ring{grid-area:mark;position:relative;z-index:1;width:20px;height:20px;margin:1px 0 0 -2px;padding:0;border:1.75px solid var(--critical);border-radius:50%;background:none;color:transparent;cursor:pointer;display:grid;place-items:center;transition:background .16s,border-color .16s,color .16s}
.ring.warning{border-color:var(--warning)}.ring.info{border-color:var(--line-strong)}
.ring::after{content:"";position:absolute;inset:-12px}
.ring .icon{width:12px;height:12px;stroke-width:2.6}
.mark.done{width:20px;height:20px;margin:1px 0 0 -2px;border-radius:0;background:none;box-shadow:none;color:var(--ok);display:grid;place-items:center}
.mark.done .icon{width:13px;height:13px;stroke-width:2.4}
/* The check is a button: pressing it puts the message back. */
button.mark.done{appearance:none;position:relative;z-index:1;grid-area:mark;border:0;padding:0;font:inherit;cursor:pointer;transition:color .16s}
button.mark.done::after{content:"";position:absolute;inset:-12px}
/* What was dealt with lately: one quiet line under the queue, which opens. */
.done-toggle{display:block;margin:0 0 0 8px;font-weight:500}
.done-toggle::after{content:"";display:inline-block;width:6px;height:6px;margin:0 0 2px 8px;border-right:1.5px solid currentColor;border-bottom:1.5px solid currentColor;transform:rotate(-45deg);transition:transform .16s}
.done-toggle[aria-expanded=true]::after{transform:rotate(45deg)}
.row.handled .who{font-weight:500}.row.handled .who,.row.handled .sum,.row.handled .why{color:var(--muted)}
.row.completing .ring{background:var(--ok);border-color:var(--ok);color:#fff}
.row.completing{animation:complete .38s ease-in forwards}
@keyframes complete{45%{opacity:1;transform:none}to{opacity:0;transform:translateX(16px)}}
/* A swipe to the right does the same on a touch screen. */
.group{overflow-x:clip}
.row.needs{touch-action:pan-y;transition:transform .18s ease-out}
.row.swiping{transform:translateX(var(--swipe,0));transition:none}
.row.swiping::before{content:"";position:absolute;top:0;bottom:0;right:100%;width:100vw;background:var(--ok-tint)}
.row.swiping::after{content:"\\2713";position:absolute;right:calc(100% + 22px);top:50%;transform:translateY(-50%);color:var(--ok);font-size:18px;font-weight:700}
.row.armed::before{background:var(--ok)}.row.armed::after{color:#fff}
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
.envelope{display:block;width:56px;height:56px;margin:0 auto 12px;color:var(--line-strong);fill:none;stroke:currentColor;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}
.envelope path{stroke-dasharray:420;stroke-dashoffset:420;animation:draw .6s ease-out forwards}
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
.byline p{margin:0}
.byline .from{font-size:14px;color:var(--text)}.byline .from b{font-weight:600}.byline .addr{color:var(--muted)}
.trust{display:flex;align-items:center;gap:4px;padding:2px 0;font-size:12px;font-weight:500;cursor:help}
.trust.pass{color:var(--ok)}.trust.fail{color:var(--critical-text)}
.trust .icon{width:14px;height:14px;flex:none}
.feedback{display:flex;flex-wrap:wrap;align-items:center;gap:0 2px;margin-top:6px;padding-top:6px;border-top:1px solid var(--line);color:var(--muted)}
.feedback>span{margin-right:6px}.feedback .text-btn{margin-left:-8px;margin-right:8px}
.text-btn.small{padding:6px 8px;min-height:32px;font-size:12px}
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
.tl-open{display:block;width:100%;margin:0;padding:0;border:0;border-radius:6px;background:none;color:inherit;font:inherit;text-align:left;cursor:pointer}
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

/* ---- Toast: what just happened, and where it helps, the one way back ---- */
.toast{position:fixed;inset:auto auto calc(16px + env(safe-area-inset-bottom)) 50%;transform:translateX(-50%);z-index:9;display:flex;align-items:center;gap:12px;width:max-content;max-width:min(380px,calc(100vw - 32px));margin:0;padding:10px 14px;border:1px solid var(--line);border-radius:10px;background:var(--surface);color:var(--text);box-shadow:var(--shadow-pop);font-size:13px;overflow:visible;animation:toast-in .18s ease-out}
.toast.failed{color:var(--critical-text)}
.toast.lifted{bottom:calc(78px + env(safe-area-inset-bottom))}
.toast.sending{bottom:calc(68px + env(safe-area-inset-bottom))}
.toast.sending.lifted{bottom:calc(130px + env(safe-area-inset-bottom))}
@keyframes toast-in{from{opacity:0;transform:translate(-50%,6px)}}

/* ---- Install steps ---- */
.steps{list-style:none;margin:4px 0 12px;padding:0;display:grid;gap:10px}
.steps li{display:flex;align-items:center;gap:12px;font-size:15px}
.steps .icon{width:20px;height:20px;color:var(--accent);flex:none}
.install-help .muted{margin:0 0 16px;font-size:13px;color:var(--muted)}

/* ---- What is loading, what just arrived, what was asked ---- */
@keyframes read{50%{opacity:.45}}
.reading{animation:read 1.6s ease-in-out infinite}
.skeleton{padding:6px 16px 0}
.skeleton-row{display:grid;gap:9px;padding:15px 0 15px 24px;border-top:1px solid var(--line)}.skeleton-row:first-child{border-top:0}
.bone{display:block;width:88%;height:10px;border-radius:5px;background:var(--fill-2);animation:read 1.4s ease-in-out infinite}
.bone.short{width:28%}.bone.mid{width:62%}
.fresh-pill{position:fixed;left:50%;top:calc(62px + env(safe-area-inset-top));transform:translateX(-50%);z-index:6;height:34px;padding:0 14px;border:0;border-radius:17px;background:var(--accent);color:var(--on-accent);font:inherit;font-size:13px;font-weight:600;box-shadow:var(--shadow-pop);cursor:pointer;white-space:nowrap;animation:toast-in .18s ease-out}
.fresh-pill::before{content:"↑ "}
.answer{margin:10px 16px 6px;padding:12px 14px;border-radius:12px;background:var(--fill);overflow-wrap:anywhere}
.answer-head{display:flex;align-items:flex-start;gap:8px;font-size:13px;color:var(--muted)}
.answer-head>.icon{flex:none;width:16px;height:16px;margin-top:1px;color:var(--accent)}
.answer-question{flex:1;min-width:0}
.answer-text{margin:8px 0 0;font-size:15px;line-height:1.6;white-space:pre-wrap}
.cite{display:inline-grid;place-items:center;min-width:18px;height:18px;margin:0 1px;padding:0 5px;border:0;border-radius:9px;background:var(--accent-tint);color:var(--accent);font:inherit;font-size:11px;font-weight:600;line-height:1;vertical-align:1px;cursor:pointer;font-variant-numeric:tabular-nums}
.answer-sources{list-style:none;margin:10px 0 0;padding:8px 0 0;border-top:1px solid var(--line);display:grid;gap:2px}
.source{display:flex;gap:8px;align-items:baseline;width:100%;margin:0;padding:5px 0;border:0;border-radius:6px;background:none;color:inherit;font:inherit;font-size:13px;line-height:1.45;text-align:left;cursor:pointer}
.source .cite{flex:none}
.source-line{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;color:var(--text-2)}.source-line b{font-weight:600;color:var(--text)}
.answer-foot{margin:8px 0 0;font-size:12px;color:var(--muted)}

/* ---- The reader: the bar of things to do, and the message as it was written ---- */
.sheet.reader .sheet-head{padding:12px 4px 0}
.sheet-nav{display:flex}
#sheet .sheet-body{padding-bottom:20px}
.action-bar{flex:none;display:flex;align-items:center;gap:4px;padding:8px 10px calc(8px + env(safe-area-inset-bottom));border-top:1px solid var(--line);background:var(--surface)}
.action-bar:empty,.pane-bar:empty{display:none}
.bar-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:44px;margin:0;padding:0 12px;border:0;border-radius:10px;background:none;color:var(--text);font:inherit;font-size:14px;font-weight:500;cursor:pointer;white-space:nowrap;transition:background .12s}
.bar-btn .icon{flex:none;width:18px;height:18px}
.bar-btn.primary{flex:1;background:var(--accent);color:var(--on-accent);font-weight:600}
.bar-btn.primary.on{background:var(--fill);color:var(--text)}.bar-btn.primary.on .icon{color:var(--ok)}
.bar-btn.icon-only{min-width:44px;padding:0}.bar-btn.icon-only span{display:none}
.bar-btn.lit{color:var(--warning)}.bar-btn.lit .icon{fill:currentColor}
.bar-btn.quiet{color:var(--muted)}
.bar-space{flex:1}
.message{margin:6px 0 0;border-top:1px solid var(--line)}
.message-head{display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:40px}
.message-head .section-label{margin:0}
.message-tools{display:flex;margin-right:-8px}
.message-note{display:flex;flex-wrap:wrap;align-items:center;gap:0 2px;margin:0 0 6px;font-size:12px;color:var(--muted)}
.message-note.caution{flex-wrap:nowrap;align-items:flex-start;gap:6px;color:var(--warning-text);font-size:13px}
.message-note .icon{flex:none;width:15px;height:15px;margin-top:2px}
.message-note .text-btn{margin:-4px 0}
.message>.inline-status,.message>.inline-error{margin:12px 0 4px}
.mail-frame{display:block;width:100%;height:96px;border:0;background:transparent}
.mail-frame.paper{border-radius:10px;background:#fff}
.mail-text{white-space:pre-wrap;word-break:break-word;font-size:15px;line-height:1.6}
.mail-text a,.detail .summary a{color:var(--accent)}
.quoted{margin-top:10px}
.quoted summary{display:inline-flex;align-items:center;gap:8px;padding:6px 0;color:var(--muted);font-size:13px;cursor:pointer;list-style:none;border-radius:6px}
.quoted summary::-webkit-details-marker{display:none}
.quoted summary::before{content:"···";padding:0 7px;border-radius:6px;background:var(--fill);color:var(--text-2);letter-spacing:1px}
.quoted-text{margin:4px 0 0;padding-left:12px;border-left:2px solid var(--line-strong);color:var(--text-2);font-size:14px}
.attachments{margin-top:10px;border-top:1px solid var(--line)}
.attachments-body{padding:2px 0 8px;font-size:13px}
.pane-bar,.pane-empty{display:none}

/* ---- Small sheets: the menu, notifications, the keyboard list ---- */
.sheet-text{margin:4px 0 12px;font-size:14px;line-height:1.55;color:var(--text-2)}
.sheet-text.lead{font-size:15px;color:var(--text)}.sheet-text.quiet{margin-top:12px;font-size:12px;color:var(--muted)}
a.primary-action{display:inline-flex;align-items:center;justify-content:center;text-decoration:none}
.primary-action:disabled{opacity:.6;cursor:default}
.menu-item{display:flex;align-items:center;gap:12px;width:100%;min-height:52px;margin:0;padding:0 4px;border:0;border-top:1px solid var(--line);border-radius:0;background:none;color:var(--text);font:inherit;font-size:15px;text-align:left;cursor:pointer}
.menu-item:first-child{border-top:0}
.menu-item .icon{flex:none;width:20px;height:20px;color:var(--muted)}
.notify-on{display:flex;align-items:center;gap:6px;margin:0 0 6px;color:var(--ok);font-size:14px;font-weight:600}
.notify-on .icon{width:16px;height:16px;stroke-width:2.4}
.devices-block{margin-top:18px}
.devices{list-style:none;margin:6px 0 0;padding:0}
.devices li{display:flex;align-items:center;gap:12px;min-height:48px;border-top:1px solid var(--line);font-size:14px}
.devices .name{flex:1;min-width:0;overflow-wrap:anywhere}
.devices small{display:block;margin-top:1px;font-size:12px;color:var(--muted)}
.message-note.caution b{font-weight:600;overflow-wrap:anywhere}
.switch small{display:block;margin-top:1px;font-size:12px;color:var(--muted)}
#notify-sheet .switch:first-of-type{border-top:0}
.segset button.seg{appearance:none;border:0;background:none;font:inherit;font-size:13px;font-weight:500;cursor:pointer}
.sheet-actions{display:flex;flex-wrap:wrap;gap:0 4px;margin:8px -8px 0}
.keys-list{display:grid;grid-template-columns:auto 1fr;gap:10px 18px;align-items:center;margin:4px 0 8px;font-size:14px}
.keys-list dt{display:flex;gap:4px}.keys-list dd{margin:0;color:var(--text-2)}
.link-btn{appearance:none;margin:0;padding:8px 2px;border:0;background:none;color:inherit;font:inherit;cursor:pointer;text-decoration:underline;text-decoration-color:var(--line-strong);text-underline-offset:.16em}
.toast-action{appearance:none;margin:0;padding:4px 2px;border:0;background:none;color:var(--accent);font:inherit;font-size:13px;font-weight:600;cursor:pointer;white-space:nowrap}

/* ---- The composer ---- */
#compose{height:calc(100vh - env(safe-area-inset-top) - 8px);height:calc(100dvh - env(safe-area-inset-top) - 8px)}
.compose .sheet-head{padding-left:8px}
.text-btn.strong{display:inline-flex;align-items:center;gap:6px;font-size:15px}
.text-btn.strong .icon{width:16px;height:16px}
#compose-form{display:flex;flex-direction:column}
.cfield{display:flex;align-items:center;gap:10px;min-height:46px;border-bottom:1px solid var(--line)}
.cfield .label{min-width:3.4em}
.cfield input,.cfield select,.ai-line input{flex:1;min-width:0;margin:0;padding:8px 0;border:0;background:none;color:var(--text);font:inherit;font-size:16px;outline:none}
.cfield .text-btn{padding:8px;min-height:36px}
.cvalue{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px;color:var(--text-2)}
.cvalue select{width:100%;font-size:14px}
.compose-ai{margin:12px 0 0;padding:4px 6px 4px 12px;border-radius:12px;background:var(--fill)}
.ai-line{display:flex;align-items:center;gap:8px}
.ai-line>.icon{flex:none;width:16px;height:16px;color:var(--accent)}
.chips{display:flex;flex-wrap:wrap;gap:6px;padding:2px 0 8px 24px}.chips:empty{display:none}
.chip{appearance:none;margin:0;padding:4px 10px;border:1px solid var(--line-strong);border-radius:999px;background:var(--surface);color:var(--text-2);font:inherit;font-size:13px;cursor:pointer}
#compose-form textarea{display:block;width:100%;min-height:160px;margin:14px 0 0;padding:0;border:0;background:none;color:var(--text);font:inherit;font-size:16px;line-height:1.6;resize:none;outline:none}
#compose-form textarea::placeholder,.cfield input::placeholder,.ai-line input::placeholder,.palette-field input::placeholder{color:var(--muted)}
.compose .quoted pre{margin:4px 0 0;padding-left:12px;border-left:2px solid var(--line-strong);max-height:38vh;overflow:auto;white-space:pre-wrap;word-break:break-word;font:inherit;font-size:13px;line-height:1.5;color:var(--muted)}
.compose-note{display:flex;flex-wrap:wrap;align-items:center;gap:0 4px;margin:8px 0 0;min-height:1.5em;font-size:13px;color:var(--muted)}
.compose-note.failed{color:var(--critical-text)}

/* ---- The palette and the lightbox: the two things that open in the middle ---- */
.palette{position:fixed;inset:12vh 0 auto;margin:0 auto;width:min(560px,calc(100vw - 24px));max-height:min(66vh,540px);padding:0;border:1px solid var(--line);border-radius:14px;background:var(--surface);color:var(--text);box-shadow:var(--shadow-pop);overflow:hidden;flex-direction:column}
.palette[open]{display:flex;animation:pop-in .14s ease-out}
.palette::backdrop{background:var(--backdrop);animation:fade .14s}
@keyframes pop-in{from{opacity:0;transform:translateY(-6px) scale(.985)}}
.palette-field{position:relative;flex:none;border-bottom:1px solid var(--line)}
.palette-field .icon{position:absolute;left:16px;top:50%;width:18px;height:18px;margin-top:-9px;color:var(--muted)}
.palette-field input{width:100%;height:52px;margin:0;padding:0 16px 0 44px;border:0;background:none;color:var(--text);font:inherit;font-size:16px;outline:none}
.palette-list{list-style:none;margin:0;padding:6px;overflow:auto;overscroll-behavior:contain}
.palette-section{padding:8px 10px 2px;font-size:11px;font-weight:600;color:var(--muted);letter-spacing:.03em}
.palette-item{display:flex;align-items:center;gap:10px;min-height:38px;padding:6px 10px;border-radius:8px;font-size:14px;cursor:pointer}
.palette-item span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.palette-item .icon{flex:none;width:16px;height:16px;color:var(--muted)}
.palette-item.on{background:var(--fill)}.palette-item.on .icon{color:var(--accent)}
.palette-none{padding:16px 10px;font-size:14px;color:var(--muted)}
.lightbox{position:fixed;inset:0;width:100%;height:100%;max-width:none;max-height:none;margin:0;padding:calc(52px + env(safe-area-inset-top)) 12px calc(20px + env(safe-area-inset-bottom));border:0;background:rgba(10,11,13,.94);place-items:center}
.lightbox[open]{display:grid;animation:fade .16s}
.lightbox::backdrop{background:transparent}
.lightbox img{max-width:100%;max-height:100%;border-radius:6px;object-fit:contain;min-height:0}
.lightbox .icon-btn{position:absolute;top:calc(4px + env(safe-area-inset-top));right:6px;color:#fff}
::view-transition-old(root),::view-transition-new(root){animation:none;mix-blend-mode:normal}

/* ---- Desktop: the list on the left, the message beside it ---- */
.pane{display:none}
@media(min-width:900px){
  .app-header{padding-left:24px;padding-right:20px}.header-inner{width:min(1440px,100%);min-height:56px}
  .install-line{display:none}
  .app-main{display:grid;grid-template-columns:minmax(340px,440px) minmax(0,1fr);gap:28px;width:min(1440px,100%);padding:12px 24px 40px;align-items:start}
  .title,.day,.row,.lane,.digest,.since{padding-left:12px;padding-right:12px}
  .lane,.digest,.answer{margin-left:0;margin-right:0}
  .skeleton{padding-left:12px;padding-right:12px}
  .banner{margin:8px 12px 0}
  .control-line{padding-left:4px}.search-line{padding-left:12px;padding-right:12px}.tokens{padding:0 4px}
  #search-open,#search-cancel{display:none}.search-line[hidden]{display:flex!important}
  .lede{font-size:24px}
  .day{top:calc(56px + env(safe-area-inset-top))}
  .row{scroll-margin-top:calc(96px + env(safe-area-inset-top))}
  .row.needs{touch-action:auto}
  .fresh-pill{left:calc(max(24px,(100vw - 1440px)/2 + 24px) + 220px)}
  .pane{display:flex;flex-direction:column;position:sticky;top:calc(68px + env(safe-area-inset-top));height:calc(100vh - 84px - env(safe-area-inset-top));overflow:hidden;border-radius:16px;background:var(--surface);box-shadow:0 0 0 1px var(--line)}
  .pane-bar{display:flex;flex:none;align-items:center;gap:2px;min-height:52px;padding:6px 10px;border-bottom:1px solid var(--line)}
  .pane-bar .bar-btn{min-height:36px;border-radius:8px;font-size:13px}
  .pane-bar .bar-btn.primary{flex:none;padding:0 14px}
  .pane-bar .bar-btn.icon-only{min-width:36px}
  .pane-body{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain;padding:20px 28px 28px}
  .pane-body .detail{max-width:760px;margin:0 auto;padding-top:0}
  .pane-body .code-band{width:calc(100% + 56px);margin:-20px -28px 16px;padding-left:28px;padding-right:28px}
  .pane-empty{display:grid;place-content:center;justify-items:center;gap:6px;min-height:100%;padding:24px;text-align:center;color:var(--muted)}
  .pane-empty .envelope{width:48px;height:48px;margin-bottom:8px}
  .pane-empty .keys{font-size:12px;color:var(--muted)}
  .pane-empty p{margin:0}
  .detail h3{font-size:20px}
  .sheet.popover{position:absolute;inset:auto;left:var(--pop-left,auto);top:var(--pop-top,auto);width:320px;max-height:min(70vh,560px);border-radius:12px;border:1px solid var(--line);box-shadow:var(--shadow-pop);background:var(--surface)}
  .sheet.popover .handle{display:none}
  .sheet.popover .sheet-head{padding-top:4px;min-height:44px}
  .sheet.popover .sheet-body{padding-bottom:12px}
  .sheet.popover.opening,.sheet.popover.closing{animation:fade .12s}
  .sheet.popover::backdrop{background:transparent}
  #compose{max-width:680px;height:min(720px,calc(100vh - 72px))}
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
  .envelope path{stroke-dashoffset:0}.verb .icon{stroke-dashoffset:0}
}
`;
}

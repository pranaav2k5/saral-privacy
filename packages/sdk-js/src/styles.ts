/** Every rule is scoped to `.sp-root`. Colours are variables so a site can restyle without touching the script. */
export const CSS = `
.sp-root{--sp-ink:#1b2a41;--sp-soft:#4a5a70;--sp-bg:#fff;--sp-rule:#c9d3da;--sp-field:#6b7a8a;--sp-accent:#0f5c6e;--sp-error:#a8321f;font:16px/1.5 system-ui,-apple-system,"Segoe UI","Noto Sans","Noto Sans Devanagari",sans-serif;color:var(--sp-ink)}
.sp-root *{box-sizing:border-box}
.sp-backdrop{position:fixed;inset:0;background:rgba(27,42,65,.55);display:flex;align-items:flex-end;justify-content:center;padding:12px;z-index:2147483000}
@media (min-width:640px){.sp-backdrop{align-items:center}}
.sp-dialog{background:var(--sp-bg);width:100%;max-width:34rem;max-height:calc(100vh - 24px);overflow:auto;border-radius:10px;padding:20px 20px 16px;box-shadow:0 20px 50px -20px rgba(0,0,0,.5)}
.sp-dialog h2{font-size:1.25rem;margin:0 0 6px}
.sp-dialog p{margin:0 0 12px;color:var(--sp-soft)}
.sp-purposes{list-style:none;margin:0 0 12px;padding:0;border-top:1px solid var(--sp-rule)}
.sp-purposes li{border-bottom:1px solid var(--sp-rule);padding:10px 0}
.sp-row{display:grid;grid-template-columns:auto 1fr;gap:2px 12px;align-items:start;cursor:pointer}
.sp-row input{grid-row:1 / span 2;width:2.5rem;height:1.5rem;margin:2px 0 0;accent-color:var(--sp-accent)}
.sp-label{font-weight:600}
.sp-desc{color:var(--sp-soft);font-size:.9rem}
.sp-state{font-weight:600;color:var(--sp-soft)}
.sp-field{margin:0 0 12px}
.sp-field label{display:block;font-weight:600}
.sp-field input{display:block;width:100%;margin-top:4px;padding:8px 10px;font:inherit;color:inherit;border:1px solid var(--sp-field);border-radius:6px}
.sp-field input[aria-invalid="true"]{border:2px solid var(--sp-error)}
.sp-hint{font-size:.85rem;color:var(--sp-soft);margin:4px 0 0}
.sp-alert{min-height:0;color:var(--sp-error);font-weight:600;margin:0 0 8px}
.sp-actions{display:flex;flex-wrap:wrap;gap:8px}
.sp-btn{flex:1 1 9rem;min-height:2.75rem;padding:8px 14px;font:inherit;font-weight:600;color:var(--sp-accent);background:var(--sp-bg);border:2px solid var(--sp-accent);border-radius:6px;cursor:pointer}
.sp-btn:hover{background:#eef2f4}
.sp-btn[disabled]{opacity:.6;cursor:progress}
.sp-opener{position:fixed;left:12px;bottom:12px;z-index:2147482999;padding:8px 12px;font:600 .9rem system-ui,sans-serif;color:var(--sp-accent);background:var(--sp-bg);border:2px solid var(--sp-accent);border-radius:999px;cursor:pointer}
.sp-status{position:fixed;left:12px;bottom:60px;z-index:2147482999;max-width:20rem;padding:8px 12px;background:var(--sp-bg);border:1px solid var(--sp-rule);border-radius:6px;font-size:.9rem}
.sp-status:empty{display:none}
.sp-root :focus-visible{outline:3px solid var(--sp-accent);outline-offset:2px}
@media (prefers-reduced-motion:no-preference){.sp-dialog{animation:sp-in .18s ease-out}@keyframes sp-in{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}}
`;

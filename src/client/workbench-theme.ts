/** Theme-token-based workbench styles, including portal dialogs. */
export const workbenchTheme = `
.te-workbench { color:var(--dsw-alias-label-primary); font-size:14px; }
.te-workbench *,.te-modal * { box-sizing:border-box; }
.te-workbench button,.te-modal button { font-family:inherit; }
.te-workbench button:focus-visible,.te-modal button:focus-visible,.te-input:focus-visible { outline:2px solid var(--dsw-alias-state-business-primary); outline-offset:3px; }
.te-workbench h2 { margin:0 0 6px; font-size:24px; letter-spacing:-.5px; }
.te-workbench h3,.te-modal h3 { margin:0; font-size:16px; overflow-wrap:anywhere; }
.te-config-layout { display:grid; grid-template-columns:minmax(0,1fr); gap:16px; align-items:start; width:100%; }
.te-config-layout.is-open { grid-template-columns:minmax(0,1fr) minmax(320px,420px); }
.te-config-main { min-width:0; }
.te-inline-panel { position:sticky !important; top:12px; min-width:0; }
.te-flow-notice { margin:0; padding:10px 12px; border:1px solid var(--dsw-alias-state-warn-primary); border-radius:8px; font-size:13px; }
.te-workbench .te-disclosure-title { font-size:16px; font-weight:700; color:var(--dsw-alias-label-primary); }
.te-binding-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(100%,320px),1fr)); gap:14px; align-items:start; }
.te-binding-picker { min-width:0; display:flex; flex-direction:column; gap:10px; border:1px solid var(--dsw-alias-border-l2); border-radius:12px; padding:14px; background:var(--dsw-alias-bg-layer-1); }
.te-binding-heading { display:flex; align-items:center; justify-content:space-between; gap:8px; }
.te-binding-heading h4 { margin:0; font-size:14px; font-weight:650; }
.te-binding-count,.te-binding-meta { color:var(--dsw-alias-label-secondary); font-size:12px; }
.te-binding-tools { display:flex; gap:10px; align-items:center; flex-wrap:wrap; }
.te-binding-tools .te-input { flex:1; width:100%; min-width:120px; padding:8px 10px; font-size:13px; }
.te-binding-filter { display:flex; align-items:center; gap:5px; font-size:12px; white-space:nowrap; cursor:pointer; }
.te-binding-list { max-height:280px; overflow-y:auto; overscroll-behavior:contain; display:flex; flex-direction:column; gap:4px; scrollbar-gutter:stable; }
/* Search + filter row. The catalog grows with every install, so finding one skill
   has to be a lookup rather than a scroll. */
.te-binding-controls { display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin:0 0 6px; }
.te-binding-search { flex:1; min-width:120px; padding:6px 9px; font-size:12px; color:var(--dsw-alias-label-primary); background:var(--dsw-alias-bg-layer-1); border:1px solid var(--dsw-alias-border-l2); border-radius:7px; }
.te-binding-search:focus-visible { outline:2px solid var(--dsw-alias-state-business-primary); outline-offset:1px; }
/* Only the open skill's rules render, and inside a bounded region: expanding a
   second skill must not push the first off screen or grow the page without limit. */
.te-rule-list { display:flex; flex-direction:column; gap:4px; margin-top:6px; padding:8px; max-height:240px; overflow-y:auto; overscroll-behavior:contain; border:1px solid var(--dsw-alias-border-l2); border-radius:8px; background:var(--dsw-alias-bg-layer-1); scrollbar-gutter:stable; }
.te-binding-option { display:flex; gap:9px; align-items:flex-start; padding:9px; border:1px solid transparent; border-radius:8px; cursor:pointer; }
.te-binding-option:hover { background:var(--dsw-alias-bg-layer-2); }
.te-binding-option.is-selected { background:var(--dsw-alias-bg-layer-2); border-color:var(--dsw-alias-border-l2); }
.te-binding-option.is-fixed { cursor:default; }
.te-binding-option input { flex:none; margin:3px 0 0; }
.te-binding-picker input { accent-color:var(--dsw-alias-state-business-primary); }
.te-binding-picker :focus-visible { outline:2px solid var(--dsw-alias-state-business-primary); outline-offset:2px; }
.te-binding-detail { min-width:0; display:flex; flex-direction:column; gap:3px; }
.te-binding-name { font-size:13px; font-weight:600; overflow-wrap:anywhere; }
.te-binding-description { color:var(--dsw-alias-label-secondary); font-size:12px; line-height:1.4; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; overflow-wrap:anywhere; }
.te-binding-empty { margin:0; padding:18px 8px; font-size:13px; }
.te-transfer { display:grid; grid-template-columns:minmax(0,1fr) 24px minmax(0,1fr); gap:12px; align-items:stretch; }
.te-transfer-pane { display:flex; flex-direction:column; min-width:0; gap:10px; padding:14px; border:1px solid var(--dsw-alias-border-l2); border-radius:12px; background:var(--dsw-alias-bg-layer-1); }
.te-transfer-pane h4 { margin:0; font-size:14px; }
.te-transfer-arrow { display:grid; place-items:center; color:var(--dsw-alias-label-tertiary); font-size:20px; }
.te-transfer-search,.te-transfer-caption { min-height:38px; width:100%; }
.te-transfer-caption { display:flex; align-items:center; margin:0; color:var(--dsw-alias-label-secondary); font-size:12px; }
.te-transfer-list { display:flex; flex-direction:column; gap:4px; min-height:180px; max-height:310px; overflow:auto; overscroll-behavior:contain; scrollbar-gutter:stable; }
.te-transfer-row { width:100%; display:flex; align-items:center; justify-content:space-between; gap:12px; border:1px solid transparent; border-radius:8px; padding:9px 11px; background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-primary); text-align:left; cursor:pointer; }
.te-transfer-row:hover { border-color:var(--dsw-alias-state-business-primary); }
.te-transfer-row.is-bound { background:var(--dsw-alias-bg-layer-1); border-color:var(--dsw-alias-border-l2); cursor:default; }
.te-transfer-row-main { min-width:0; display:flex; flex-direction:column; gap:2px; }
.te-transfer-row-main strong { font-size:13px; font-weight:600; overflow-wrap:anywhere; }
.te-transfer-row-main small { color:var(--dsw-alias-label-secondary); font-size:11px; line-height:1.35; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.te-transfer-action { flex:none; display:grid; place-items:center; width:27px; height:27px; border-radius:7px; background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-state-business-primary); font-size:18px; }
.te-transfer-actions { flex:none; display:flex; align-items:center; gap:6px; }
.te-transfer-config,.te-transfer-remove { border:0; border-radius:7px; padding:6px 8px; background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-primary); cursor:pointer; font-size:12px; white-space:nowrap; }
.te-transfer-config:hover,.te-transfer-remove:hover { color:var(--dsw-alias-state-business-primary); }
.te-transfer-remove { width:27px; height:27px; padding:0; font-size:19px; line-height:1; }
.te-dialog-error { color:var(--dsw-alias-state-error-primary); font-size:12px; margin-right:auto; }
.te-skill-config { display:flex; flex:1; flex-direction:column; gap:12px; min-width:0; min-height:0; }
.te-skill-evidence { display:flex; align-items:center; justify-content:space-between; gap:12px; font-size:13px; font-weight:600; }
.te-skill-evidence .te-input { min-width:210px; }
.te-skill-rule-list { display:flex; flex:1; flex-direction:column; gap:4px; min-height:0; overflow:auto; padding:4px; }
.te-skill-rule-row { display:flex; align-items:center; gap:10px; padding:9px 10px; border:1px solid var(--dsw-alias-border-l2); border-radius:8px; cursor:pointer; }
.te-skill-rule-row:hover { background:var(--dsw-alias-bg-layer-1); }
.te-skill-rule-row span { flex:1; min-width:0; overflow-wrap:anywhere; }
.te-skill-rule-row small { color:var(--dsw-alias-label-secondary); }
.te-workbench p,.te-modal p { color:var(--dsw-alias-label-secondary); line-height:1.65; }
.te-content { max-width:1600px; margin:auto; width:100%; }
.te-resource { display:flex; flex-direction:column; gap:20px; }
.te-section-heading { display:flex; justify-content:space-between; align-items:center; gap:16px; flex-wrap:wrap; }
.te-section-heading p { margin:0; }
.te-actions { display:flex; align-items:center; flex-wrap:wrap; gap:10px; }
.te-toolbar { display:flex; flex-wrap:wrap; align-items:center; gap:12px; }
.te-toolbar>input { flex:1; min-width:180px; }
.te-input { background:var(--dsw-alias-bg-layer-1); border:1px solid var(--dsw-alias-border-l2); border-radius:10px; padding:10px 12px; font:inherit; color:var(--dsw-alias-label-primary); min-width:0; }
.te-resource-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(min(100%,320px),1fr)); gap:16px; }
.te-resource-card { display:flex; flex-direction:column; gap:14px; background:var(--dsw-alias-bg-layer-1); border:1px solid var(--dsw-alias-border-l2); border-radius:16px; padding:20px; transition:border-color .15s; }
.te-resource-card:hover { border-color:var(--dsw-alias-state-business-primary); }
.te-resource-card p { margin:0; font-size:13px; flex:1; }
.te-card-top { display:flex; justify-content:space-between; align-items:center; }
.te-resource-icon { display:grid; place-items:center; width:36px; height:36px; border-radius:10px; background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-state-business-primary); font-size:25px; }
.te-badge { display:inline-flex; border-radius:20px; background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-secondary); padding:4px 10px; font-size:12px; }
.te-delete,.te-link { border:none; background:transparent; cursor:pointer; padding:8px; color:var(--dsw-alias-label-secondary); }
.te-delete { margin-left:auto; }
.te-delete:hover { color:var(--dsw-alias-state-error-primary); }
.te-link { text-align:left; align-self:flex-start; text-decoration:underline; }
.te-danger-button { border:0; border-radius:9px; padding:10px 16px; background:var(--dsw-alias-state-error-primary); color:white; cursor:pointer; }
.te-danger-button:disabled { opacity:.5; cursor:wait; }
.te-alert,.te-success { padding:12px 16px; border-radius:10px; border:1px solid currentColor; overflow-wrap:anywhere; font-size:13px; }
.te-alert { color:var(--dsw-alias-state-error-primary); }
.te-success { color:var(--dsw-alias-state-success-primary); }
.te-empty { text-align:center; padding:56px 24px; border:1px dashed var(--dsw-alias-border-l2); border-radius:16px; color:var(--dsw-alias-label-secondary); }
.te-targets { display:grid; grid-template-columns:1fr 1fr; gap:12px; margin:4px 0 16px; }
.te-target { display:flex; flex-direction:column; align-items:flex-start; gap:6px; padding:16px; border-radius:12px; border:1px solid var(--dsw-alias-border-l2); background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-label-primary); cursor:pointer; }
.te-target small { color:var(--dsw-alias-label-secondary); text-align:left; }
.te-target.selected { border-color:var(--dsw-alias-state-business-primary); box-shadow:0 0 0 1px var(--dsw-alias-state-business-primary); }
.te-path { display:block; grid-column:1/-1; padding:10px 12px; font-size:12px; border-radius:8px; background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-label-secondary); overflow-wrap:anywhere; white-space:pre-wrap; }
.te-preview { display:flex; flex-direction:column; gap:12px; margin-top:16px; }
.te-markdown { max-height:360px; overflow:auto; padding:16px; border:1px solid var(--dsw-alias-border-l2); border-radius:12px; }
.te-advanced { margin-top:16px; padding:12px; border:1px dashed var(--dsw-alias-border-l2); border-radius:12px; }
.te-dir-list { max-height:160px; overflow:auto; display:flex; flex-direction:column; gap:4px; }
.te-dir-list button { text-align:left; border:0; background:transparent; color:var(--dsw-alias-label-primary); padding:8px; cursor:pointer; }
.te-dir-list button:hover { background:var(--dsw-alias-bg-layer-1); }
.te-form { display:flex; flex-direction:column; gap:16px; }
.te-form label { display:flex; flex-direction:column; gap:8px; font-size:13px; }
.te-editor { min-height:260px; resize:vertical; line-height:1.6; font-family:monospace; }
@media(max-width:760px) { .te-transfer {grid-template-columns:1fr;} .te-transfer-arrow {transform:rotate(90deg); height:20px;} .te-transfer-list {max-height:210px;} }
@media(max-width:1000px) { .te-config-layout.is-open { grid-template-columns:minmax(0,1fr); } .te-inline-panel { position:static !important; height:min(600px,calc(100vh - 32px)) !important; } }
@media(max-width:640px) { .te-targets {grid-template-columns:1fr;} .te-resource {gap:14px;} .te-section-heading h2 {font-size:21px;} .te-modal:not(.te-drawer) {padding:10px !important;} .te-drawer [role=dialog] {border-radius:0 !important;} .te-skill-evidence {align-items:stretch; flex-direction:column;} .te-skill-evidence .te-input {min-width:0;} }
`

"use strict";var J=Object.create;var C=Object.defineProperty;var X=Object.getOwnPropertyDescriptor;var Q=Object.getOwnPropertyNames;var Z=Object.getPrototypeOf,tt=Object.prototype.hasOwnProperty;var et=(s,t)=>{for(var e in t)C(s,e,{get:t[e],enumerable:!0})},q=(s,t,e,o)=>{if(t&&typeof t=="object"||typeof t=="function")for(let n of Q(t))!tt.call(s,n)&&n!==e&&C(s,n,{get:()=>t[n],enumerable:!(o=X(t,n))||o.enumerable});return s};var p=(s,t,e)=>(e=s!=null?J(Z(s)):{},q(t||!s||!s.__esModule?C(e,"default",{value:s,enumerable:!0}):e,s)),st=s=>q(C({},"__esModule",{value:!0}),s);var pt={};et(pt,{activate:()=>dt,deactivate:()=>lt});module.exports=st(pt);var m=p(require("vscode")),S=p(require("path")),w=p(require("os"));var F=p(require("path"));var N=p(require("fs")),j=p(require("better-sqlite3")),L=class{db;constructor(t){this.db=new j.default(t,{readonly:!0,fileMustExist:!0}),this.db.pragma("journal_mode = WAL")}async all(t,e){return this.db.prepare(t).all(...e)}async get(t,e){return this.db.prepare(t).get(...e)}close(){this.db.close()}};async function g(s){if(!N.existsSync(s))throw new Error(`Database not found: ${s}`);return new L(s)}var ot="Code/User/globalStorage/github.copilot-chat/agent-traces.db",k=class{db=null;dbPath;constructor(t){this.dbPath=F.join(t,ot)}async getDb(){return this.db||(this.db=await g(this.dbPath)),this.db}async isAvailable(){try{return await this.getDb()!==null}catch{return!1}}async getSpansForSession(t){return(await this.getDb()).all(`
      SELECT
        s.span_id,
        s.trace_id,
        s.operation_name,
        s.request_model,
        s.response_model,
        s.input_tokens,
        s.output_tokens,
        s.cached_tokens,
        CAST(COALESCE(a.value, '0') AS INTEGER) AS cache_write_tokens,
        COALESCE(s.reasoning_tokens, 0) AS reasoning_tokens,
        s.start_time_ms,
        s.end_time_ms,
        s.ttft_ms,
        s.chat_session_id,
        s.conversation_id,
        s.turn_index,
        s.status_code,
        s.status_message,
        s.tool_name
      FROM spans s
      LEFT JOIN span_attributes a
        ON a.span_id = s.span_id
        AND a.key = 'gen_ai.usage.cache_creation.input_tokens'
      WHERE s.operation_name = 'chat'
        AND (s.chat_session_id = ? OR s.conversation_id = ?)
      ORDER BY s.start_time_ms ASC
    `,[t,t])}async getSpansSince(t){return(await this.getDb()).all(`
      SELECT
        s.span_id,
        s.trace_id,
        s.operation_name,
        s.request_model,
        s.response_model,
        s.input_tokens,
        s.output_tokens,
        s.cached_tokens,
        CAST(COALESCE(a.value, '0') AS INTEGER) AS cache_write_tokens,
        COALESCE(s.reasoning_tokens, 0) AS reasoning_tokens,
        s.start_time_ms,
        s.end_time_ms,
        s.ttft_ms,
        s.chat_session_id,
        s.conversation_id,
        s.turn_index,
        s.status_code,
        s.status_message,
        s.tool_name
      FROM spans s
      LEFT JOIN span_attributes a
        ON a.span_id = s.span_id
        AND a.key = 'gen_ai.usage.cache_creation.input_tokens'
      WHERE s.operation_name = 'chat'
        AND s.start_time_ms >= ?
      ORDER BY s.start_time_ms ASC
    `,[t])}async getRecentSessionSpans(t){let n=await(await this.getDb()).all(`
      SELECT DISTINCT COALESCE(conversation_id, chat_session_id) AS session_id,
             MAX(start_time_ms) AS last_activity
      FROM spans
      WHERE operation_name = 'chat'
      GROUP BY COALESCE(conversation_id, chat_session_id)
      ORDER BY last_activity DESC
      LIMIT ?
    `,[t]),r=new Map;for(let{session_id:a}of n){let i=await this.getSpansForSession(a);r.set(a,i)}return r}dispose(){this.db?.close(),this.db=null}};var H=p(require("path"));var nt="Code/User/globalStorage/github.copilot-chat/session-store.db",T=class{db=null;dbPath;constructor(t){this.dbPath=H.join(t,nt)}async getDb(){return this.db||(this.db=await g(this.dbPath)),this.db}async isAvailable(){try{return await this.getDb()!==null}catch{return!1}}async getSessionMetadata(t){let n=await(await this.getDb()).get(`
      SELECT id, summary, agent_name, created_at, updated_at, cwd, repository, branch
      FROM sessions
      WHERE id = ?
    `,[t]);return n?U(n):null}async getRecentSessions(t){return(await(await this.getDb()).all(`
      SELECT id, summary, agent_name, created_at, updated_at, cwd, repository, branch
      FROM sessions
      ORDER BY updated_at DESC
      LIMIT ?
    `,[t])).map(U)}dispose(){this.db?.close(),this.db=null}};function U(s){return{id:s.id,summary:s.summary,agentName:s.agent_name,createdAt:s.created_at,updatedAt:s.updated_at,cwd:s.cwd,repository:s.repository,branch:s.branch}}var D=class{db=null;cache=null;dbPath;constructor(t){this.dbPath=`${t}/state.vscdb`}async getDb(){return this.db||(this.db=await g(this.dbPath)),this.db}async isAvailable(){try{return await this.getDb()!==null}catch{return!1}}async getTitle(t){return(await this.getAllTitles()).get(t)??null}async getAllTitles(){if(this.cache)return this.cache;let o=await(await this.getDb()).get("SELECT value FROM ItemTable WHERE key = 'chat.ChatSessionStore.index'",[]),n=new Map;if(!o?.value)return n;try{let r=JSON.parse(o.value);if(r.entries)for(let[a,i]of Object.entries(r.entries))i.title&&n.set(a,i.title)}catch{}return this.cache=n,n}invalidateCache(){this.cache=null}dispose(){this.db?.close(),this.db=null,this.cache=null}};var z={"claude-opus-4-5":{input:5,output:25,cached:.5,cacheWrite:6.25},"claude-opus-4-6":{input:5,output:25,cached:.5,cacheWrite:6.25},"claude-opus-4-7":{input:5,output:25,cached:.5,cacheWrite:6.25},"claude-sonnet-4":{input:3,output:15,cached:.3,cacheWrite:3.75},"claude-sonnet-4-5":{input:3,output:15,cached:.3,cacheWrite:3.75},"claude-sonnet-4-6":{input:3,output:15,cached:.3,cacheWrite:3.75},"claude-haiku-4-5":{input:1,output:5,cached:.1,cacheWrite:1.25},"gpt-4.1":{input:2,output:8,cached:.5},"gpt-5-mini":{input:.25,output:2,cached:.025},"gpt-5.2":{input:1.75,output:14,cached:.175},"gpt-5.2-codex":{input:1.75,output:14,cached:.175},"gpt-5.3-codex":{input:1.75,output:14,cached:.175},"gpt-5.4":{input:2.5,output:15,cached:.25},"gpt-5.4-mini":{input:.75,output:4.5,cached:.075},"gpt-5.4-nano":{input:.2,output:1.25,cached:.02},"gpt-5.5":{input:5,output:30,cached:.5},"gpt-4o-mini":{input:.15,output:.6,cached:.075},"gpt-4o":{input:2.5,output:10,cached:1.25},o1:{input:15,output:60,cached:7.5},"o1-mini":{input:3,output:12,cached:1.5},"o3-mini":{input:1.1,output:4.4,cached:.55},"gemini-2.5-pro":{input:1.25,output:10,cached:.125},"gemini-3-flash":{input:.5,output:3,cached:.05},"gemini-3.1-pro":{input:2,output:12,cached:.2},"gemini-3.5-flash":{input:1.5,output:9,cached:.15},"raptor-mini":{input:.25,output:2,cached:.025},goldeneye:{input:1.25,output:10,cached:.125}};var _=class{pricing;matchCache=new Map;constructor(t){this.pricing=new Map;for(let[e,o]of Object.entries(z))this.pricing.set(e,o);if(t)for(let[e,o]of Object.entries(t))this.pricing.set(e,o)}resolve(t){if(!t)return null;if(this.matchCache.has(t))return this.matchCache.get(t);let e=t.toLowerCase().trim();if(this.pricing.has(e)){let i=this.pricing.get(e);return this.matchCache.set(t,i),i}let o=e.replace(/-\d{8}$/,"");if(this.pricing.has(o)){let i=this.pricing.get(o);return this.matchCache.set(t,i),i}let n=e.replace(/-\d{4}-\d{2}-\d{2}$/,"");if(this.pricing.has(n)){let i=this.pricing.get(n);return this.matchCache.set(t,i),i}let r=null,a=0;for(let[i,c]of this.pricing)e.startsWith(i)&&i.length>a&&(r=c,a=i.length);if(!r)for(let[i,c]of this.pricing)e.includes(i)&&i.length>a&&(r=c,a=i.length);return this.matchCache.set(t,r),r}getKnownModels(){return Array.from(this.pricing.keys())}};var x=class{constructor(t){this.pricingEngine=t}calculate(t,e,o,n,r){let a=this.pricingEngine.resolve(t);return a?this.calculateWithRates(a,e,o,n,r):null}calculateWithRates(t,e,o,n,r){let i=Math.max(0,e-n)/1e6*t.input,c=n/1e6*t.cached,d=t.cacheWrite?r/1e6*t.cacheWrite:0,l=o/1e6*t.output;return{freshInputCost:i,cacheReadCost:c,cacheWriteCost:d,outputCost:l,totalCost:i+c+d+l}}};var M=class{constructor(t){this.calculator=t}buildDashboard(t,e,o){let n=new Date,r=P(n).getTime(),a=it(n).getTime(),i=t.filter(l=>l.startTimeMs>=r),c=t.filter(l=>l.startTimeMs>=a),d=o?t.filter(l=>at(l,o)):[];return{today:this.aggregatePeriod(i),thisWeek:this.aggregatePeriod(c),currentSession:{...this.aggregatePeriod(d),sessionId:o},last7Days:this.buildDailyBuckets(t,n),recentSessions:this.buildRecentSessions(t,e),updatedAt:n.toISOString()}}aggregatePeriod(t){let e=new Map;for(let c of t){let d=c.responseModel??c.requestModel??"unknown",l=e.get(d)??{calls:0,inputTokens:0,outputTokens:0,cachedTokens:0,cacheWriteTokens:0};l.calls++,l.inputTokens+=c.inputTokens,l.outputTokens+=c.outputTokens,l.cachedTokens+=c.cachedTokens,l.cacheWriteTokens+=c.cacheWriteTokens,e.set(d,l)}let o=[],n=0,r=0,a=0,i=0;for(let[c,d]of e){let l=this.calculator.calculate(c,d.inputTokens,d.outputTokens,d.cachedTokens,d.cacheWriteTokens),u={model:c,calls:d.calls,inputTokens:d.inputTokens,outputTokens:d.outputTokens,cachedTokens:d.cachedTokens,cacheWriteTokens:d.cacheWriteTokens,freshInputCost:l?.freshInputCost??0,cacheReadCost:l?.cacheReadCost??0,cacheWriteCost:l?.cacheWriteCost??0,outputCost:l?.outputCost??0,totalCost:l?.totalCost??0};o.push(u),n+=u.totalCost,r+=d.inputTokens,a+=d.outputTokens,i+=d.cachedTokens}return{totalCost:n,requests:t.length,inputTokens:r,outputTokens:a,cachedTokens:i,byModel:o.sort((c,d)=>d.totalCost-c.totalCost)}}buildDailyBuckets(t,e){let o=[],n=["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];for(let r=6;r>=0;r--){let a=new Date(e);a.setDate(a.getDate()-r);let i=P(a).getTime(),c=i+24*60*60*1e3,d=t.filter(u=>u.startTimeMs>=i&&u.startTimeMs<c),l=this.aggregatePeriod(d);o.push({date:rt(a),dayLabel:n[a.getDay()],totalCost:l.totalCost,requests:l.requests})}return o}buildRecentSessions(t,e){let o=new Map;for(let r of t){let a=r.conversationId??r.chatSessionId??"unknown",i=o.get(a)??[];i.push(r),o.set(a,i)}let n=[];for(let[r,a]of o){let i=this.aggregatePeriod(a),c=Math.min(...a.map(u=>u.startTimeMs)),d=Math.max(...a.map(u=>u.endTimeMs)),l=i.byModel[0]?.model??null;n.push({sessionId:r,title:e.get(r)??`Session ${r.slice(0,8)}`,model:l,agentName:null,startedAt:c,endedAt:d,totalCost:i.totalCost,requests:i.requests})}return n.sort((r,a)=>a.endedAt-r.endedAt).slice(0,20)}};function at(s,t){return s.chatSessionId===t||s.conversationId===t}function P(s){let t=new Date(s);return t.setHours(0,0,0,0),t}function it(s){let t=P(s),e=t.getDay(),o=e===0?6:e-1;return t.setDate(t.getDate()-o),t}function rt(s){return s.toISOString().slice(0,10)}var Y=p(require("vscode")),E=class{constructor(t,e,o,n){this.spanRepo=t;this.titleResolver=e;this.aggregator=o;this.getPollingInterval=n}_onDidUpdate=new Y.EventEmitter;onDidUpdate=this._onDidUpdate.event;timer=null;lastData=null;currentSessionId=null;disposed=!1;start(){this.poll(),this.scheduleNext()}async refresh(){await this.poll()}getLastData(){return this.lastData}getCurrentSessionId(){return this.currentSessionId}resetSession(){this.currentSessionId=null}scheduleNext(){if(this.disposed)return;this.timer&&clearInterval(this.timer);let t=this.getPollingInterval()*1e3;this.timer=setInterval(()=>this.poll(),t)}async poll(){if(!this.disposed)try{if(!await this.spanRepo.isAvailable())return;let e=Date.now()-7*24*60*60*1e3,o=await this.spanRepo.getSpansSince(e);if(o.length===0){this.lastData=this.emptyDashboard(),this._onDidUpdate.fire(this.lastData);return}this.currentSessionId=this.detectCurrentSession(o);let n=await this.titleResolver.getAllTitles();this.lastData=this.aggregator.buildDashboard(o,n,this.currentSessionId),this._onDidUpdate.fire(this.lastData)}catch(t){console.error("[CopilotCostTracker] Poll error:",t)}}detectCurrentSession(t){if(t.length===0)return null;let e=t[0];for(let n of t)n.startTimeMs>e.startTimeMs&&(e=n);let o=Date.now()-60*60*1e3;return e.startTimeMs<o?null:e.conversationId??e.chatSessionId??null}emptyDashboard(){let t={totalCost:0,requests:0,inputTokens:0,outputTokens:0,cachedTokens:0,byModel:[]};return{today:t,thisWeek:t,currentSession:{...t,sessionId:null},last7Days:[],recentSessions:[],updatedAt:new Date().toISOString()}}onConfigurationChanged(){this.scheduleNext()}dispose(){this.disposed=!0,this.timer&&(clearInterval(this.timer),this.timer=null),this._onDidUpdate.dispose()}};var f=p(require("vscode")),R=class{constructor(t){this.getThresholds=t}_onDidChangeBudgetState=new f.EventEmitter;onDidChangeBudgetState=this._onDidChangeBudgetState.event;lastState={sessionLevel:"ok",dailyLevel:"ok",weeklyLevel:"ok"};firedAlerts=new Set;evaluate(t){let e=this.getThresholds(),o=this.checkLevel(t.currentSession.totalCost,e.session),n=this.checkLevel(t.today.totalCost,e.daily),r=this.checkLevel(t.thisWeek.totalCost,e.weekly),a={sessionLevel:o,dailyLevel:n,weeklyLevel:r};return this.maybeNotify("session",o,t.currentSession.totalCost,e.session),this.maybeNotify("daily",n,t.today.totalCost,e.daily),this.maybeNotify("weekly",r,t.thisWeek.totalCost,e.weekly),(a.sessionLevel!==this.lastState.sessionLevel||a.dailyLevel!==this.lastState.dailyLevel||a.weeklyLevel!==this.lastState.weeklyLevel)&&(this.lastState=a,this._onDidChangeBudgetState.fire(a)),a}getState(){return this.lastState}resetAlerts(){this.firedAlerts.clear(),this.lastState={sessionLevel:"ok",dailyLevel:"ok",weeklyLevel:"ok"},this._onDidChangeBudgetState.fire(this.lastState)}checkLevel(t,e){return t>=e.limit?"limit":t>=e.warning?"warning":"ok"}maybeNotify(t,e,o,n){let r=`${t}:${e}`;if(e==="ok"){this.firedAlerts.delete(`${t}:warning`),this.firedAlerts.delete(`${t}:limit`);return}if(this.firedAlerts.has(r))return;this.firedAlerts.add(r);let a=`$${o.toFixed(2)}`,i=t.charAt(0).toUpperCase()+t.slice(1);e==="warning"?f.window.showWarningMessage(`Copilot Cost: ${i} spend ${a} has reached the warning threshold ($${n.warning}).`):e==="limit"&&f.window.showErrorMessage(`Copilot Cost: ${i} spend ${a} has exceeded the limit ($${n.limit})!`)}dispose(){this._onDidChangeBudgetState.dispose()}};var h=p(require("vscode")),A=class{statusBarItem;constructor(){this.statusBarItem=h.window.createStatusBarItem(h.StatusBarAlignment.Left,50),this.statusBarItem.command="copilotCostTracker.openDashboard",this.statusBarItem.tooltip="Click to open Copilot Cost Dashboard",this.statusBarItem.text="$(pulse) Copilot Cost: --",this.statusBarItem.show()}update(t,e){let o=b(t.currentSession.totalCost),n=b(t.today.totalCost);this.statusBarItem.text=`$(pulse) Session: ${o} | Today: ${n}`,this.statusBarItem.backgroundColor=this.getBackgroundColor(e),this.statusBarItem.tooltip=this.buildTooltip(t,e)}getBackgroundColor(t){if(t.sessionLevel==="limit"||t.dailyLevel==="limit"||t.weeklyLevel==="limit")return new h.ThemeColor("statusBarItem.errorBackground");if(t.sessionLevel==="warning"||t.dailyLevel==="warning"||t.weeklyLevel==="warning")return new h.ThemeColor("statusBarItem.warningBackground")}buildTooltip(t,e){let o=["Copilot Cost Tracker","\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500",`Session: ${b(t.currentSession.totalCost)} (${t.currentSession.requests} requests)`,`Today:   ${b(t.today.totalCost)} (${t.today.requests} requests)`,`Week:    ${b(t.thisWeek.totalCost)} (${t.thisWeek.requests} requests)`,"",`Tokens today: ${B(t.today.inputTokens)} in / ${B(t.today.outputTokens)} out / ${B(t.today.cachedTokens)} cached`,"",`Updated: ${new Date(t.updatedAt).toLocaleTimeString()}`];return(e.sessionLevel!=="ok"||e.dailyLevel!=="ok"||e.weeklyLevel!=="ok")&&o.push("","\u26A0\uFE0F Budget alert active"),o.join(`
`)}dispose(){this.statusBarItem.dispose()}};function b(s){return s<.01&&s>0?"< $0.01":`$${s.toFixed(2)}`}function B(s){return s>=1e6?`${(s/1e6).toFixed(1)}M`:s>=1e3?`${(s/1e3).toFixed(1)}K`:`${s}`}var W=p(require("vscode")),y=class{constructor(t){this.extensionUri=t}static viewType="copilotCostTracker.dashboard";view;pendingData=null;pendingBudgetState=null;resolveWebviewView(t,e,o){this.view=t,t.webview.options={enableScripts:!0,localResourceRoots:[this.extensionUri]},t.webview.html=this.getHtml(t.webview),t.webview.onDidReceiveMessage(n=>{switch(n.command){case"refresh":W.commands.executeCommand("copilotCostTracker.refresh");break;case"openSettings":W.commands.executeCommand("copilotCostTracker.openSettings");break}}),this.pendingData&&this.updateData(this.pendingData,this.pendingBudgetState)}updateData(t,e){this.pendingData=t,this.pendingBudgetState=e,this.view?.visible&&this.view.webview.postMessage({type:"update",data:t,budgetState:e})}getHtml(t){let e=ct();return`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${e}'; script-src 'nonce-${e}';">
  <style nonce="${e}">
    :root {
      --card-bg: var(--vscode-editor-background);
      --card-border: var(--vscode-panel-border);
      --text-primary: var(--vscode-foreground);
      --text-secondary: var(--vscode-descriptionForeground);
      --text-muted: var(--vscode-disabledForeground);
      --accent: var(--vscode-textLink-foreground);
      --cost-green: #4ec9b0;
      --cost-yellow: #dcdcaa;
      --cost-red: #f14c4c;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--text-primary);
      padding: 8px;
      line-height: 1.4;
    }

    .section {
      margin-bottom: 16px;
      padding: 12px;
      border: 1px solid var(--card-border);
      border-radius: 4px;
      background: var(--card-bg);
    }

    .section-header {
      font-size: 0.75em;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--text-secondary);
      margin-bottom: 8px;
      font-weight: 600;
    }

    .cost-large {
      font-size: 1.8em;
      font-weight: 700;
      margin-bottom: 4px;
    }

    .cost-green { color: var(--cost-green); }
    .cost-yellow { color: var(--cost-yellow); }
    .cost-red { color: var(--cost-red); }

    .stat-row {
      display: flex;
      justify-content: space-between;
      padding: 2px 0;
      font-size: 0.85em;
    }

    .stat-label { color: var(--text-secondary); }
    .stat-value { font-weight: 500; }

    .model-table {
      width: 100%;
      font-size: 0.85em;
    }

    .model-row {
      display: flex;
      justify-content: space-between;
      padding: 3px 0;
      border-bottom: 1px solid var(--card-border);
    }

    .model-row:last-child { border-bottom: none; }
    .model-name { color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; }
    .model-cost { font-weight: 500; white-space: nowrap; margin-left: 8px; }

    .chart-container {
      display: flex;
      align-items: flex-end;
      gap: 4px;
      height: 60px;
      padding-top: 8px;
    }

    .chart-bar-wrapper {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      height: 100%;
    }

    .chart-bar {
      width: 100%;
      background: var(--accent);
      border-radius: 2px 2px 0 0;
      min-height: 2px;
      margin-top: auto;
    }

    .chart-label {
      font-size: 0.65em;
      color: var(--text-muted);
      margin-top: 4px;
    }

    .session-list { list-style: none; }

    .session-item {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 6px 0;
      border-bottom: 1px solid var(--card-border);
    }

    .session-item:last-child { border-bottom: none; }

    .session-info {
      overflow: hidden;
    }

    .session-title {
      font-weight: 500;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .session-meta {
      font-size: 0.75em;
      color: var(--text-secondary);
    }

    .session-cost {
      font-weight: 600;
      white-space: nowrap;
      margin-left: 8px;
    }

    .toolbar {
      display: flex;
      gap: 8px;
      margin-bottom: 12px;
      justify-content: flex-end;
    }

    .toolbar button {
      background: none;
      border: none;
      color: var(--accent);
      cursor: pointer;
      font-size: 0.8em;
      text-decoration: underline;
    }

    .toolbar button:hover { opacity: 0.8; }

    .empty-state {
      text-align: center;
      padding: 24px;
      color: var(--text-muted);
    }

    .updated-at {
      text-align: center;
      font-size: 0.7em;
      color: var(--text-muted);
      margin-top: 12px;
    }
  </style>
</head>
<body>
  <div class="toolbar">
    <button id="btn-refresh">Refresh</button>
    <button id="btn-settings">Settings</button>
  </div>

  <div id="content">
    <div class="empty-state">Waiting for Copilot usage data...</div>
  </div>

  <script nonce="${e}">
    const vscode = acquireVsCodeApi();

    document.getElementById('btn-refresh').addEventListener('click', () => {
      vscode.postMessage({ command: 'refresh' });
    });
    document.getElementById('btn-settings').addEventListener('click', () => {
      vscode.postMessage({ command: 'openSettings' });
    });

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg.type === 'update') {
        render(msg.data, msg.budgetState);
      }
    });

    function render(data, budgetState) {
      const content = document.getElementById('content');
      if (!data || (data.today.requests === 0 && data.thisWeek.requests === 0)) {
        content.innerHTML = '<div class="empty-state">No Copilot usage data found yet.</div>';
        return;
      }

      const html = [
        renderSection('TODAY', renderCostCard(data.today, budgetState?.dailyLevel)),
        renderSection('THIS WEEK', renderWeekCard(data.thisWeek)),
        renderSection('TODAY BY MODEL', renderModelTable(data.today.byModel)),
        renderSection('CURRENT SESSION', renderCostCard(data.currentSession, budgetState?.sessionLevel)),
        renderSection('LAST 7 DAYS', renderChart(data.last7Days)),
        renderSection('RECENT SESSIONS', renderSessionList(data.recentSessions)),
        '<div class="updated-at">Updated: ' + formatTime(data.updatedAt) + '</div>',
      ].join('');

      content.innerHTML = html;
    }

    function renderSection(title, body) {
      return '<div class="section"><div class="section-header">' + title + '</div>' + body + '</div>';
    }

    function renderCostCard(period, level) {
      const colorClass = level === 'limit' ? 'cost-red' : level === 'warning' ? 'cost-yellow' : 'cost-green';
      return '<div class="cost-large ' + colorClass + '">' + formatCost(period.totalCost) + '</div>' +
        statRow('Requests', period.requests) +
        statRow('Input Tokens', formatTokens(period.inputTokens)) +
        statRow('Output Tokens', formatTokens(period.outputTokens)) +
        statRow('Cached Tokens', formatTokens(period.cachedTokens));
    }

    function renderWeekCard(period) {
      return '<div class="cost-large cost-green">' + formatCost(period.totalCost) + '</div>' +
        statRow('Requests', period.requests);
    }

    function renderModelTable(models) {
      if (!models || models.length === 0) return '<div class="empty-state">No model data</div>';
      return '<div class="model-table">' +
        models.map(m =>
          '<div class="model-row"><span class="model-name">' + shortModel(m.model) +
          '</span><span class="model-cost">' + formatCost(m.totalCost) + '</span></div>'
        ).join('') + '</div>';
    }

    function renderChart(days) {
      if (!days || days.length === 0) return '<div class="empty-state">No data</div>';
      const maxCost = Math.max(...days.map(d => d.totalCost), 0.01);
      return '<div class="chart-container">' +
        days.map(d => {
          const pct = Math.max((d.totalCost / maxCost) * 100, 2);
          return '<div class="chart-bar-wrapper">' +
            '<div class="chart-bar" style="height:' + pct + '%"></div>' +
            '<span class="chart-label">' + d.dayLabel + '</span></div>';
        }).join('') + '</div>';
    }

    function renderSessionList(sessions) {
      if (!sessions || sessions.length === 0) return '<div class="empty-state">No sessions</div>';
      return '<ul class="session-list">' +
        sessions.slice(0, 10).map(s =>
          '<li class="session-item"><div class="session-info"><div class="session-title">' +
          escapeHtml(s.title) + '</div><div class="session-meta">' +
          (s.model ? shortModel(s.model) + ' \u2022 ' : '') + timeAgo(s.endedAt) +
          '</div></div><span class="session-cost">' + formatCost(s.totalCost) + '</span></li>'
        ).join('') + '</ul>';
    }

    function statRow(label, value) {
      return '<div class="stat-row"><span class="stat-label">' + label + '</span><span class="stat-value">' + value + '</span></div>';
    }

    function formatCost(cost) {
      if (cost < 0.01 && cost > 0) return '< $0.01';
      return '$' + cost.toFixed(2);
    }

    function formatTokens(count) {
      if (count >= 1000000) return (count / 1000000).toFixed(1) + 'M';
      if (count >= 1000) return (count / 1000).toFixed(1) + 'K';
      return '' + count;
    }

    function shortModel(model) {
      return model.replace(/-\\d{8}$/, '').replace(/-\\d{4}-\\d{2}-\\d{2}$/, '');
    }

    function timeAgo(ms) {
      const diff = Date.now() - ms;
      const mins = Math.floor(diff / 60000);
      if (mins < 1) return 'just now';
      if (mins < 60) return mins + ' min ago';
      const hours = Math.floor(mins / 60);
      if (hours < 24) return hours + ' hour' + (hours > 1 ? 's' : '') + ' ago';
      const days = Math.floor(hours / 24);
      return days + ' day' + (days > 1 ? 's' : '') + ' ago';
    }

    function formatTime(iso) {
      return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }

    function escapeHtml(str) {
      const div = document.createElement('div');
      div.textContent = str;
      return div.innerHTML;
    }
  </script>
</body>
</html>`}};function ct(){let s="",t="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";for(let e=0;e<32;e++)s+=t.charAt(Math.floor(Math.random()*t.length));return s}var I=p(require("vscode")),O="copilotCostTracker";function G(){return I.workspace.getConfiguration(O).get("pollingInterval",10)}function K(){let s=I.workspace.getConfiguration(O);return{session:{warning:s.get("budget.session.warning",5),limit:s.get("budget.session.limit",8)},daily:{warning:s.get("budget.daily.warning",20),limit:s.get("budget.daily.limit",50)},weekly:{warning:s.get("budget.weekly.warning",25),limit:s.get("budget.weekly.limit",50)}}}function V(){let t=I.workspace.getConfiguration(O).get("pricingOverrides");if(!(!t||Object.keys(t).length===0))return t}function dt(s){let t=ut(),e=new k(t),o=new T(t),n=new D(s.globalStorageUri.fsPath),r=new _(V()),a=new x(r),i=new M(a),c=new E(e,n,i,G),d=new R(K),l=new A,u=new y(s.extensionUri);s.subscriptions.push(m.window.registerWebviewViewProvider(y.viewType,u)),c.onDidUpdate(v=>{let $=d.evaluate(v);l.update(v,$),u.updateData(v,$)}),s.subscriptions.push(m.commands.registerCommand("copilotCostTracker.refresh",()=>{c.refresh()}),m.commands.registerCommand("copilotCostTracker.resetSession",()=>{c.resetSession(),d.resetAlerts()}),m.commands.registerCommand("copilotCostTracker.openDashboard",()=>{m.commands.executeCommand("copilotCostTracker.dashboard.focus")}),m.commands.registerCommand("copilotCostTracker.openSettings",()=>{m.commands.executeCommand("workbench.action.openSettings","copilotCostTracker")})),s.subscriptions.push(m.workspace.onDidChangeConfiguration(v=>{v.affectsConfiguration("copilotCostTracker")&&c.onConfigurationChanged()})),c.start(),s.subscriptions.push(c,d,l,e,o,n)}function lt(){}function ut(){switch(process.platform){case"win32":return process.env.APPDATA??S.join(w.homedir(),"AppData","Roaming");case"darwin":return S.join(w.homedir(),"Library","Application Support");case"linux":return process.env.XDG_CONFIG_HOME??S.join(w.homedir(),".config");default:return S.join(w.homedir(),".config")}}0&&(module.exports={activate,deactivate});
//# sourceMappingURL=extension.js.map

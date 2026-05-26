"use strict";var ot=Object.create;var D=Object.defineProperty;var nt=Object.getOwnPropertyDescriptor;var it=Object.getOwnPropertyNames;var rt=Object.getPrototypeOf,at=Object.prototype.hasOwnProperty;var ct=(s,t)=>{for(var e in t)D(s,e,{get:t[e],enumerable:!0})},U=(s,t,e,o)=>{if(t&&typeof t=="object"||typeof t=="function")for(let n of it(t))!at.call(s,n)&&n!==e&&D(s,n,{get:()=>t[n],enumerable:!(o=nt(t,n))||o.enumerable});return s};var u=(s,t,e)=>(e=s!=null?ot(rt(s)):{},U(t||!s||!s.__esModule?D(e,"default",{value:s,enumerable:!0}):e,s)),dt=s=>U(D({},"__esModule",{value:!0}),s);var St={};ct(St,{activate:()=>bt,deactivate:()=>yt});module.exports=dt(St);var h=u(require("vscode")),f=u(require("path")),T=u(require("os"));var G=u(require("path"));var b=u(require("fs")),v=u(require("path")),H=require("child_process"),m=class s{static instance=null;process=null;requestId=0;pending=new Map;buffer="";starting=null;static getInstance(){return s.instance||(s.instance=new s),s.instance}getWorkerPath(){let t=v.join(__dirname,"db-worker.js");if(b.existsSync(t))return t;let e=v.join(__dirname,"..","src","data","db-worker.js");return b.existsSync(e)?e:v.join(__dirname,"db-worker.js")}async ensureStarted(){if(!(this.process&&!this.process.killed))return this.starting?this.starting:(this.starting=new Promise((t,e)=>{let o=this.getWorkerPath(),n=process.execPath,a=lt();this.process=(0,H.spawn)(a,[o],{stdio:["pipe","pipe","pipe"],env:{...process.env}}),this.process.stdout.setEncoding("utf8"),this.process.stdout.on("data",i=>{this.buffer+=i;let r;for(;(r=this.buffer.indexOf(`
`))!==-1;){let l=this.buffer.slice(0,r).trim();this.buffer=this.buffer.slice(r+1),l&&this.handleResponse(l)}}),this.process.stderr.on("data",i=>{console.error("[CopilotCostTracker Worker]",i.toString())}),this.process.on("exit",i=>{this.process=null,this.starting=null;for(let[,{reject:r}]of this.pending)r(new Error(`Worker exited with code ${i}`));this.pending.clear()}),setTimeout(()=>t(),50)}),this.starting)}handleResponse(t){try{let e=JSON.parse(t),o=this.pending.get(e.id);if(!o)return;this.pending.delete(e.id),e.error?o.reject(new Error(e.error)):o.resolve(e.result)}catch{}}async send(t,e={}){if(await this.ensureStarted(),!this.process||!this.process.stdin)throw new Error("Worker process not available");let o=++this.requestId,n={id:o,action:t,...e};return new Promise((a,i)=>{this.pending.set(o,{resolve:a,reject:i}),this.process.stdin.write(JSON.stringify(n)+`
`),setTimeout(()=>{this.pending.has(o)&&(this.pending.delete(o),i(new Error(`Worker request timed out (action=${t})`)))},1e4)})}kill(){this.process&&(this.process.stdin?.end(),this.process.kill(),this.process=null),this.starting=null,s.instance=null}},W=class{handle=null;dbPath;opening=null;constructor(t){this.dbPath=t}async ensureOpen(){return this.handle!==null?this.handle:this.opening?(await this.opening,this.handle):(this.opening=(async()=>{let e=await m.getInstance().send("open",{dbPath:this.dbPath});this.handle=e.handle})(),await this.opening,this.handle)}async all(t,e){let o=await this.ensureOpen();return(await m.getInstance().send("all",{handle:o,sql:t,params:e})).rows}async get(t,e){let o=await this.ensureOpen();return(await m.getInstance().send("get",{handle:o,sql:t,params:e})).row}close(){this.handle!==null&&(m.getInstance().send("close",{handle:this.handle}).catch(()=>{}),this.handle=null,this.opening=null)}};async function y(s){if(!b.existsSync(s))throw new Error(`Database not found: ${s}`);return new W(s)}function z(){m.getInstance().kill()}function lt(){if(process.platform==="win32"){let s=ut("node.exe");if(s)return s;let t=process.env.ProgramFiles??"C:\\Program Files",e=v.join(t,"nodejs","node.exe");if(b.existsSync(e))return e}return"node"}function ut(s){let t=process.env.PATH??"",e=process.platform==="win32"?";":":";for(let o of t.split(e)){let n=v.join(o,s);if(b.existsSync(n))return n}return null}var pt="Code/User/globalStorage/github.copilot-chat/agent-traces.db",Y=`
  SELECT
    s.span_id AS spanId,
    s.trace_id AS traceId,
    s.operation_name AS operationName,
    s.request_model AS requestModel,
    s.response_model AS responseModel,
    s.input_tokens AS inputTokens,
    s.output_tokens AS outputTokens,
    s.cached_tokens AS cachedTokens,
    CAST(COALESCE(a.value, '0') AS INTEGER) AS cacheWriteTokens,
    COALESCE(s.reasoning_tokens, 0) AS reasoningTokens,
    s.start_time_ms AS startTimeMs,
    s.end_time_ms AS endTimeMs,
    s.ttft_ms AS ttftMs,
    s.chat_session_id AS chatSessionId,
    s.conversation_id AS conversationId,
    s.turn_index AS turnIndex,
    s.status_code AS statusCode,
    s.status_message AS statusMessage,
    s.tool_name AS toolName
  FROM spans s
  LEFT JOIN span_attributes a
    ON a.span_id = s.span_id
    AND a.key = 'gen_ai.usage.cache_creation.input_tokens'
`,x=class{db=null;dbPath;constructor(t){this.dbPath=G.join(t,pt)}async getDb(){return this.db||(this.db=await y(this.dbPath)),this.db}async isAvailable(){try{return await this.getDb()!==null}catch{return!1}}async getSpansForSession(t){let e=await this.getDb(),o=Y+`
      WHERE s.operation_name = 'chat'
        AND (s.chat_session_id = ? OR s.conversation_id = ?)
      ORDER BY s.start_time_ms ASC
    `;return e.all(o,[t,t])}async getSpansSince(t){let e=await this.getDb(),o=Y+`
      WHERE s.operation_name = 'chat'
        AND s.start_time_ms >= ?
      ORDER BY s.start_time_ms ASC
    `;return e.all(o,[t])}async getRecentSessionSpans(t){let n=await(await this.getDb()).all(`
      SELECT DISTINCT COALESCE(conversation_id, chat_session_id) AS session_id,
             MAX(start_time_ms) AS last_activity
      FROM spans
      WHERE operation_name = 'chat'
      GROUP BY COALESCE(conversation_id, chat_session_id)
      ORDER BY last_activity DESC
      LIMIT ?
    `,[t]),a=new Map;for(let{session_id:i}of n){let r=await this.getSpansForSession(i);a.set(i,r)}return a}dispose(){this.db?.close(),this.db=null}};var V=u(require("path"));var ht="Code/User/globalStorage/github.copilot-chat/session-store.db",M=class{db=null;dbPath;constructor(t){this.dbPath=V.join(t,ht)}async getDb(){return this.db||(this.db=await y(this.dbPath)),this.db}async isAvailable(){try{return await this.getDb()!==null}catch{return!1}}async getSessionMetadata(t){let n=await(await this.getDb()).get(`
      SELECT id, summary, agent_name, created_at, updated_at, cwd, repository, branch
      FROM sessions
      WHERE id = ?
    `,[t]);return n?K(n):null}async getRecentSessions(t){return(await(await this.getDb()).all(`
      SELECT id, summary, agent_name, created_at, updated_at, cwd, repository, branch
      FROM sessions
      ORDER BY updated_at DESC
      LIMIT ?
    `,[t])).map(K)}dispose(){this.db?.close(),this.db=null}};function K(s){return{id:s.id,summary:s.summary,agentName:s.agent_name,createdAt:s.created_at,updatedAt:s.updated_at,cwd:s.cwd,repository:s.repository,branch:s.branch}}var J=u(require("fs")),X=u(require("path"));var _=class{db=null;cache=null;dbPath;constructor(t){this.dbPath=t?X.join(t,"state.vscdb"):null}async getDb(){if(!this.dbPath)return null;if(this.db)return this.db;if(!J.existsSync(this.dbPath))return null;try{return this.db=await y(this.dbPath),this.db}catch{return null}}async isAvailable(){return await this.getDb()!==null}async getTitle(t){return(await this.getAllTitles()).get(t)??null}async getAllTitles(){if(this.cache)return this.cache;let t=new Map,e=await this.getDb();if(!e)return t;let n=await e.get("SELECT value FROM ItemTable WHERE key = 'chat.ChatSessionStore.index'",[]);if(!n?.value)return t;try{let a=JSON.parse(n.value);if(a.entries)for(let[i,r]of Object.entries(a.entries))r.title&&t.set(i,r.title)}catch{}return this.cache=t,t}invalidateCache(){this.cache=null}dispose(){this.db?.close(),this.db=null,this.cache=null}};var Q={"claude-opus-4-5":{input:5,output:25,cached:.5,cacheWrite:6.25},"claude-opus-4-6":{input:5,output:25,cached:.5,cacheWrite:6.25},"claude-opus-4-7":{input:5,output:25,cached:.5,cacheWrite:6.25},"claude-sonnet-4":{input:3,output:15,cached:.3,cacheWrite:3.75},"claude-sonnet-4-5":{input:3,output:15,cached:.3,cacheWrite:3.75},"claude-sonnet-4-6":{input:3,output:15,cached:.3,cacheWrite:3.75},"claude-haiku-4-5":{input:1,output:5,cached:.1,cacheWrite:1.25},"gpt-4.1":{input:2,output:8,cached:.5},"gpt-5-mini":{input:.25,output:2,cached:.025},"gpt-5.2":{input:1.75,output:14,cached:.175},"gpt-5.2-codex":{input:1.75,output:14,cached:.175},"gpt-5.3-codex":{input:1.75,output:14,cached:.175},"gpt-5.4":{input:2.5,output:15,cached:.25},"gpt-5.4-mini":{input:.75,output:4.5,cached:.075},"gpt-5.4-nano":{input:.2,output:1.25,cached:.02},"gpt-5.5":{input:5,output:30,cached:.5},"gpt-4o-mini":{input:.15,output:.6,cached:.075},"gpt-4o":{input:2.5,output:10,cached:1.25},o1:{input:15,output:60,cached:7.5},"o1-mini":{input:3,output:12,cached:1.5},"o3-mini":{input:1.1,output:4.4,cached:.55},"gemini-2.5-pro":{input:1.25,output:10,cached:.125},"gemini-3-flash":{input:.5,output:3,cached:.05},"gemini-3.1-pro":{input:2,output:12,cached:.2},"gemini-3.5-flash":{input:1.5,output:9,cached:.15},"raptor-mini":{input:.25,output:2,cached:.025},goldeneye:{input:1.25,output:10,cached:.125}};var P=class{pricing;matchCache=new Map;constructor(t){this.pricing=new Map;for(let[e,o]of Object.entries(Q))this.pricing.set(e,o);if(t)for(let[e,o]of Object.entries(t))this.pricing.set(e,o)}resolve(t){if(!t)return null;if(this.matchCache.has(t))return this.matchCache.get(t);let e=t.toLowerCase().trim();if(this.pricing.has(e)){let r=this.pricing.get(e);return this.matchCache.set(t,r),r}let o=e.replace(/-\d{8}$/,"");if(this.pricing.has(o)){let r=this.pricing.get(o);return this.matchCache.set(t,r),r}let n=e.replace(/-\d{4}-\d{2}-\d{2}$/,"");if(this.pricing.has(n)){let r=this.pricing.get(n);return this.matchCache.set(t,r),r}let a=null,i=0;for(let[r,l]of this.pricing)e.startsWith(r)&&r.length>i&&(a=l,i=r.length);if(!a)for(let[r,l]of this.pricing)e.includes(r)&&r.length>i&&(a=l,i=r.length);return this.matchCache.set(t,a),a}getKnownModels(){return Array.from(this.pricing.keys())}};var A=class{constructor(t){this.pricingEngine=t}calculate(t,e,o,n,a){let i=this.pricingEngine.resolve(t);return i?this.calculateWithRates(i,e,o,n,a):null}calculateWithRates(t,e,o,n,a){let r=Math.max(0,e-n)/1e6*t.input,l=n/1e6*t.cached,c=t.cacheWrite?a/1e6*t.cacheWrite:0,d=o/1e6*t.output;return{freshInputCost:r,cacheReadCost:l,cacheWriteCost:c,outputCost:d,totalCost:r+l+c+d}}};var I=class{constructor(t){this.calculator=t}buildDashboard(t,e,o){let n=new Date,a=O(n).getTime(),i=gt(n).getTime(),r=t.filter(d=>d.startTimeMs>=a),l=t.filter(d=>d.startTimeMs>=i),c=o?t.filter(d=>mt(d,o)):[];return{today:this.aggregatePeriod(r),thisWeek:this.aggregatePeriod(l),currentSession:{...this.aggregatePeriod(c),sessionId:o},last7Days:this.buildDailyBuckets(t,n),recentSessions:this.buildRecentSessions(t,e),updatedAt:n.toISOString()}}aggregatePeriod(t){let e=new Map;for(let l of t){let c=l.responseModel??l.requestModel??"unknown",d=e.get(c)??{calls:0,inputTokens:0,outputTokens:0,cachedTokens:0,cacheWriteTokens:0};d.calls++,d.inputTokens+=l.inputTokens,d.outputTokens+=l.outputTokens,d.cachedTokens+=l.cachedTokens,d.cacheWriteTokens+=l.cacheWriteTokens,e.set(c,d)}let o=[],n=0,a=0,i=0,r=0;for(let[l,c]of e){let d=this.calculator.calculate(l,c.inputTokens,c.outputTokens,c.cachedTokens,c.cacheWriteTokens),p={model:l,calls:c.calls,inputTokens:c.inputTokens,outputTokens:c.outputTokens,cachedTokens:c.cachedTokens,cacheWriteTokens:c.cacheWriteTokens,freshInputCost:d?.freshInputCost??0,cacheReadCost:d?.cacheReadCost??0,cacheWriteCost:d?.cacheWriteCost??0,outputCost:d?.outputCost??0,totalCost:d?.totalCost??0};o.push(p),n+=p.totalCost,a+=c.inputTokens,i+=c.outputTokens,r+=c.cachedTokens}return{totalCost:n,requests:t.length,inputTokens:a,outputTokens:i,cachedTokens:r,byModel:o.sort((l,c)=>c.totalCost-l.totalCost)}}buildDailyBuckets(t,e){let o=[],n=["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];for(let a=6;a>=0;a--){let i=new Date(e);i.setDate(i.getDate()-a);let r=O(i).getTime(),l=r+24*60*60*1e3,c=t.filter(p=>p.startTimeMs>=r&&p.startTimeMs<l),d=this.aggregatePeriod(c);o.push({date:ft(i),dayLabel:n[i.getDay()],totalCost:d.totalCost,requests:d.requests})}return o}buildRecentSessions(t,e){let o=new Map;for(let a of t){let i=a.conversationId??a.chatSessionId??"unknown",r=o.get(i)??[];r.push(a),o.set(i,r)}let n=[];for(let[a,i]of o){let r=this.aggregatePeriod(i),l=Math.min(...i.map(p=>p.startTimeMs)),c=Math.max(...i.map(p=>p.endTimeMs)),d=r.byModel[0]?.model??null;n.push({sessionId:a,title:e.get(a)??`Session ${a.slice(0,8)}`,model:d,agentName:null,startedAt:l,endedAt:c,totalCost:r.totalCost,requests:r.requests})}return n.sort((a,i)=>i.endedAt-a.endedAt).slice(0,20)}};function mt(s,t){return s.chatSessionId===t||s.conversationId===t}function O(s){let t=new Date(s);return t.setHours(0,0,0,0),t}function gt(s){let t=O(s),e=t.getDay(),o=e===0?6:e-1;return t.setDate(t.getDate()-o),t}function ft(s){return s.toISOString().slice(0,10)}var Z=u(require("vscode")),E=class{constructor(t,e,o,n){this.spanRepo=t;this.titleResolver=e;this.aggregator=o;this.getPollingInterval=n}_onDidUpdate=new Z.EventEmitter;onDidUpdate=this._onDidUpdate.event;timer=null;lastData=null;currentSessionId=null;disposed=!1;start(){this.poll(),this.scheduleNext()}async refresh(){await this.poll()}getLastData(){return this.lastData}getCurrentSessionId(){return this.currentSessionId}resetSession(){this.currentSessionId=null}scheduleNext(){if(this.disposed)return;this.timer&&clearInterval(this.timer);let t=this.getPollingInterval()*1e3;this.timer=setInterval(()=>this.poll(),t)}async poll(){if(!this.disposed)try{if(!await this.spanRepo.isAvailable()){console.warn("[CopilotCostTracker] Database not available");return}let e=Date.now()-7*24*60*60*1e3,o=await this.spanRepo.getSpansSince(e);if(o.length===0){console.log("[CopilotCostTracker] No spans found in last 7 days"),this.lastData=this.emptyDashboard(),this._onDidUpdate.fire(this.lastData);return}console.log(`[CopilotCostTracker] Polled ${o.length} spans`),this.currentSessionId=this.detectCurrentSession(o);let n=await this.titleResolver.getAllTitles();this.lastData=this.aggregator.buildDashboard(o,n,this.currentSessionId),this._onDidUpdate.fire(this.lastData)}catch(t){console.error("[CopilotCostTracker] Poll error:",t)}}detectCurrentSession(t){if(t.length===0)return null;let e=t[0];for(let n of t)n.startTimeMs>e.startTimeMs&&(e=n);let o=Date.now()-60*60*1e3;return e.startTimeMs<o?null:e.conversationId??e.chatSessionId??null}emptyDashboard(){let t={totalCost:0,requests:0,inputTokens:0,outputTokens:0,cachedTokens:0,byModel:[]};return{today:t,thisWeek:t,currentSession:{...t,sessionId:null},last7Days:[],recentSessions:[],updatedAt:new Date().toISOString()}}onConfigurationChanged(){this.scheduleNext()}dispose(){this.disposed=!0,this.timer&&(clearInterval(this.timer),this.timer=null),this._onDidUpdate.dispose()}};var S=u(require("vscode")),R=class{constructor(t){this.getThresholds=t}_onDidChangeBudgetState=new S.EventEmitter;onDidChangeBudgetState=this._onDidChangeBudgetState.event;lastState={sessionLevel:"ok",dailyLevel:"ok",weeklyLevel:"ok"};firedAlerts=new Set;evaluate(t){let e=this.getThresholds(),o=this.checkLevel(t.currentSession.totalCost,e.session),n=this.checkLevel(t.today.totalCost,e.daily),a=this.checkLevel(t.thisWeek.totalCost,e.weekly),i={sessionLevel:o,dailyLevel:n,weeklyLevel:a};return this.maybeNotify("session",o,t.currentSession.totalCost,e.session),this.maybeNotify("daily",n,t.today.totalCost,e.daily),this.maybeNotify("weekly",a,t.thisWeek.totalCost,e.weekly),(i.sessionLevel!==this.lastState.sessionLevel||i.dailyLevel!==this.lastState.dailyLevel||i.weeklyLevel!==this.lastState.weeklyLevel)&&(this.lastState=i,this._onDidChangeBudgetState.fire(i)),i}getState(){return this.lastState}resetAlerts(){this.firedAlerts.clear(),this.lastState={sessionLevel:"ok",dailyLevel:"ok",weeklyLevel:"ok"},this._onDidChangeBudgetState.fire(this.lastState)}checkLevel(t,e){return t>=e.limit?"limit":t>=e.warning?"warning":"ok"}maybeNotify(t,e,o,n){let a=`${t}:${e}`;if(e==="ok"){this.firedAlerts.delete(`${t}:warning`),this.firedAlerts.delete(`${t}:limit`);return}if(this.firedAlerts.has(a))return;this.firedAlerts.add(a);let i=`$${o.toFixed(2)}`,r=t.charAt(0).toUpperCase()+t.slice(1);e==="warning"?S.window.showWarningMessage(`Copilot Cost: ${r} spend ${i} has reached the warning threshold ($${n.warning}).`):e==="limit"&&S.window.showErrorMessage(`Copilot Cost: ${r} spend ${i} has exceeded the limit ($${n.limit})!`)}dispose(){this._onDidChangeBudgetState.dispose()}};var g=u(require("vscode")),L=class{statusBarItem;constructor(){this.statusBarItem=g.window.createStatusBarItem(g.StatusBarAlignment.Left,50),this.statusBarItem.command="copilotCostTracker.openDashboard",this.statusBarItem.tooltip="Click to open Copilot Cost Dashboard",this.statusBarItem.text="$(pulse) Copilot Cost: --",this.statusBarItem.show()}update(t,e){let o=C(t.currentSession.totalCost),n=C(t.today.totalCost);this.statusBarItem.text=`$(pulse) Session: ${o} | Today: ${n}`,this.statusBarItem.backgroundColor=this.getBackgroundColor(e),this.statusBarItem.tooltip=this.buildTooltip(t,e)}getBackgroundColor(t){if(t.sessionLevel==="limit"||t.dailyLevel==="limit"||t.weeklyLevel==="limit")return new g.ThemeColor("statusBarItem.errorBackground");if(t.sessionLevel==="warning"||t.dailyLevel==="warning"||t.weeklyLevel==="warning")return new g.ThemeColor("statusBarItem.warningBackground")}buildTooltip(t,e){let o=["Copilot Cost Tracker","\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500",`Session: ${C(t.currentSession.totalCost)} (${t.currentSession.requests} requests)`,`Today:   ${C(t.today.totalCost)} (${t.today.requests} requests)`,`Week:    ${C(t.thisWeek.totalCost)} (${t.thisWeek.requests} requests)`,"",`Tokens today: ${j(t.today.inputTokens)} in / ${j(t.today.outputTokens)} out / ${j(t.today.cachedTokens)} cached`,"",`Updated: ${new Date(t.updatedAt).toLocaleTimeString()}`];return(e.sessionLevel!=="ok"||e.dailyLevel!=="ok"||e.weeklyLevel!=="ok")&&o.push("","\u26A0\uFE0F Budget alert active"),o.join(`
`)}dispose(){this.statusBarItem.dispose()}};function C(s){return s<.01&&s>0?"< $0.01":`$${s.toFixed(2)}`}function j(s){return s>=1e6?`${(s/1e6).toFixed(1)}M`:s>=1e3?`${(s/1e3).toFixed(1)}K`:`${s}`}var $=u(require("vscode")),k=class{constructor(t){this.extensionUri=t}static viewType="copilotCostTracker.dashboard";view;pendingData=null;pendingBudgetState=null;resolveWebviewView(t,e,o){this.view=t,t.webview.options={enableScripts:!0,localResourceRoots:[this.extensionUri]},t.webview.html=this.getHtml(t.webview),t.webview.onDidReceiveMessage(n=>{switch(n.command){case"refresh":$.commands.executeCommand("copilotCostTracker.refresh");break;case"openSettings":$.commands.executeCommand("copilotCostTracker.openSettings");break}}),this.pendingData&&this.updateData(this.pendingData,this.pendingBudgetState)}updateData(t,e){this.pendingData=t,this.pendingBudgetState=e,this.view?.visible&&this.view.webview.postMessage({type:"update",data:t,budgetState:e})}getHtml(t){let e=vt();return`<!DOCTYPE html>
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
</html>`}};function vt(){let s="",t="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";for(let e=0;e<32;e++)s+=t.charAt(Math.floor(Math.random()*t.length));return s}var B=u(require("vscode")),N="copilotCostTracker";function tt(){return B.workspace.getConfiguration(N).get("pollingInterval",10)}function et(){let s=B.workspace.getConfiguration(N);return{session:{warning:s.get("budget.session.warning",5),limit:s.get("budget.session.limit",8)},daily:{warning:s.get("budget.daily.warning",20),limit:s.get("budget.daily.limit",50)},weekly:{warning:s.get("budget.weekly.warning",25),limit:s.get("budget.weekly.limit",50)}}}function st(){let t=B.workspace.getConfiguration(N).get("pricingOverrides");if(!(!t||Object.keys(t).length===0))return t}function bt(s){let t=wt(),e=new x(t),o=new M(t),n=s.storageUri?f.dirname(s.storageUri.fsPath):null,a=new _(n),i=new P(st()),r=new A(i),l=new I(r),c=new E(e,a,l,tt),d=new R(et),p=new L,q=new k(s.extensionUri);s.subscriptions.push(h.window.registerWebviewViewProvider(k.viewType,q)),c.onDidUpdate(w=>{let F=d.evaluate(w);p.update(w,F),q.updateData(w,F)}),s.subscriptions.push(h.commands.registerCommand("copilotCostTracker.refresh",()=>{c.refresh()}),h.commands.registerCommand("copilotCostTracker.resetSession",()=>{c.resetSession(),d.resetAlerts()}),h.commands.registerCommand("copilotCostTracker.openDashboard",()=>{h.commands.executeCommand("copilotCostTracker.dashboard.focus")}),h.commands.registerCommand("copilotCostTracker.openSettings",()=>{h.commands.executeCommand("workbench.action.openSettings","copilotCostTracker")})),s.subscriptions.push(h.workspace.onDidChangeConfiguration(w=>{w.affectsConfiguration("copilotCostTracker")&&c.onConfigurationChanged()})),c.start(),s.subscriptions.push(c,d,p,e,o,a)}function yt(){z()}function wt(){switch(process.platform){case"win32":return process.env.APPDATA??f.join(T.homedir(),"AppData","Roaming");case"darwin":return f.join(T.homedir(),"Library","Application Support");case"linux":return process.env.XDG_CONFIG_HOME??f.join(T.homedir(),".config");default:return f.join(T.homedir(),".config")}}0&&(module.exports={activate,deactivate});
//# sourceMappingURL=extension.js.map

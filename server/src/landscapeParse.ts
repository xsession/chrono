// @ts-nocheck -- ported verbatim from the Codebase Landscape Map artifact so the
// server finds exactly the same imports, types and symbols the map expects.
// Edit both together. Typed wrappers live in landscape.ts.

export const LANG={js:'JavaScript',jsx:'JavaScript',mjs:'JavaScript',cjs:'JavaScript',ts:'TypeScript',tsx:'TypeScript',mts:'TypeScript',cts:'TypeScript',vue:'Vue',svelte:'Svelte',py:'Python',go:'Go',rs:'Rust',java:'Java',kt:'Kotlin',kts:'Kotlin',scala:'Scala',c:'C',h:'C',cpp:'C++',cc:'C++',cxx:'C++',hpp:'C++',hh:'C++',cs:'C#',rb:'Ruby',php:'PHP',swift:'Swift',m:'Objective-C',dart:'Dart',lua:'Lua',ex:'Elixir',exs:'Elixir',erl:'Erlang',hs:'Haskell',clj:'Clojure',jl:'Julia',r:'R',sh:'Shell',bash:'Shell',zsh:'Shell',ps1:'PowerShell',sql:'SQL',css:'CSS',scss:'SCSS',sass:'SCSS',less:'Less',html:'HTML',htm:'HTML',md:'Markdown',mdx:'Markdown',rst:'Docs',json:'JSON',yml:'YAML',yaml:'YAML',toml:'TOML',xml:'XML',gradle:'Gradle',proto:'Proto',graphql:'GraphQL',gql:'GraphQL',tf:'Terraform',repl:'Platform',resc:'Renode script',robot:'Robot test',resource:'Robot test'};
export const FAM={JavaScript:'js',TypeScript:'js',Vue:'js',Svelte:'js',Python:'py',Go:'go',Rust:'rs',Java:'jvm',Kotlin:'jvm',Scala:'jvm','C#':'cs',C:'c','C++':'c','Objective-C':'c',CSS:'css',SCSS:'css',Less:'css',Ruby:'rb',PHP:'php',Dart:'dart',Lua:'lua',HTML:'html',Platform:'renode','Renode script':'renode','Robot test':'renode'};
export const SKIP=/(^|\/)(node_modules|bower_components|\.git|\.hg|\.svn|dist|build|out|target|vendor|\.next|\.nuxt|\.svelte-kit|__pycache__|\.venv|venv|\.tox|coverage|\.idea|\.vscode|\.cache|\.gradle|Pods|DerivedData|\.terraform)(\/|$)/;
export const SKIPF=/(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|poetry\.lock|composer\.lock|Gemfile\.lock|go\.sum)$|\.min\.(js|css)$|\.map$/i;
export const extOf=p=>{const m=/\.([a-z0-9]+)$/i.exec(p);return m?m[1].toLowerCase():''};
export const countLoc=t=>{if(!t)return 1;let n=0,blank=true;for(let i=0;i<t.length;i++){const c=t.charCodeAt(i);if(c===10){if(!blank)n++;blank=true}else if(c!==32&&c!==9&&c!==13)blank=false}if(!blank)n++;return Math.max(1,n)};
export function specsOf(t,fam){
 const o=[];const R=(re,fn)=>{let m;while((m=re.exec(t))){const v=fn?fn(m):m[1];if(Array.isArray(v))o.push(...v);else if(v)o.push(v)}};
 const names=s=>s.split(',').map(n=>n.trim().split(/\s+/)[0]).filter(n=>n&&n!=='*'&&n!=='(');
 switch(fam){
  case'js':R(/(?:import|export)\s[^'"`;]*?\sfrom\s*['"]([^'"\n]+)['"]/g);R(/import\s*['"]([^'"\n]+)['"]/g);R(/require\(\s*['"]([^'"\n]+)['"]\s*\)/g);R(/import\(\s*['"]([^'"\n]+)['"]\s*\)/g);break;
  case'py':R(/^[ \t]*from[ \t]+([.\w]+)[ \t]+import[ \t]+\(?([\w, \t*]+)/gm,m=>/^\.+$/.test(m[1])?names(m[2]).map(n=>m[1]+n):m[1]);R(/^[ \t]*import[ \t]+([\w.][\w., \t]*)/gm,m=>names(m[1]));break;
  case'go':R(/import\s*\(([^)]*)\)/g,m=>(m[1].match(/"[^"]+"/g)||[]).map(x=>x.slice(1,-1)));R(/import\s+(?:[\w.]+\s+)?"([^"]+)"/g);break;
  case'rs':R(/^[ \t]*(?:pub(?:\([^)]*\))?[ \t]+)?mod[ \t]+(\w+)[ \t]*;/gm,m=>'mod:'+m[1]);R(/\b(?:crate|super)::((?:\w+::)*\w+)/g,m=>'crate:'+m[1].replace(/::/g,'/'));break;
  case'jvm':R(/^[ \t]*import[ \t]+(?:static[ \t]+)?([\w.]+)/gm);break;
  case'cs':break;
  case'renode':R(/@([\w./-]+\.(?:repl|resc|py|robot|resource))/g,m=>'root:'+m[1]);R(/using\s+"([^"]+)"/g,m=>'root:'+m[1]);R(/^Resource\s+(\S+)/gm,m=>m[1].includes('${')&&!m[1].startsWith('${CURDIR}')?null:'rel:'+m[1].replace(/^\$\{CURDIR\}\//,''));R(/^[ \t]*[\w.]+[ \t]*:[ \t]*([A-Z][\w.]*)[ \t]*@/gm,m=>'type:'+m[1]);break;
  case'c':R(/#[ \t]*(?:include|import)[ \t]*"([^"]+)"/g);break;
  case'css':R(/@(?:import|use|forward)\s+(?:url\()?\s*['"]([^'"]+)['"]/g);break;
  case'rb':R(/require_relative\s*\(?\s*['"]([^'"]+)['"]/g,m=>m[1].startsWith('.')?m[1]:'./'+m[1]);R(/\brequire\s*\(?\s*['"]([^'"]+)['"]/g);break;
  case'php':R(/(?:require|include)(?:_once)?\s*\(?\s*(?:__DIR__\s*\.\s*)?['"]([^'"]+)['"]/g);R(/^[ \t]*use[ \t]+([\w\\]+)/gm);break;
  case'dart':R(/(?:import|export|part)\s+['"]([^'"]+)['"]/g);break;
  case'lua':R(/require\s*\(?\s*['"]([^'"]+)['"]/g,m=>m[1].replace(/\./g,'/'));break;
  case'html':R(/<(?:script|link)\b[^>]*?\s(?:src|href)\s*=\s*["']([^"']+)["']/gi);break;
 }
 return[...new Set(o)];
}
export function csInfo(t){
 const c=t.replace(/\/\*[\s\S]*?\*\//g,'').replace(/\/\/[^\n]*/g,'').replace(/@?"(?:[^"\\\n]|\\.)*"/g,'""');
 const ns=[...c.matchAll(/\bnamespace\s+([\w.]+)/g)].map(m=>m[1]),uses=[...c.matchAll(/^[ \t]*(?:global[ \t]+)?using[ \t]+(?:static[ \t]+)?([\w.]+)[ \t]*;/gm)].map(m=>m[1]);
 const decl=[...new Set([...c.matchAll(/\b(?:class|interface|struct|enum|record|delegate[ \t]+[\w<>,.\[\] ]+?)[ \t]+([A-Z_]\w*)/g)].map(m=>m[1]))];
 const ds=new Set(decl),toks=[...new Set(c.match(/\b[A-Z_][A-Za-z0-9_]*\b/g)||[])].filter(x=>!ds.has(x)&&x.length>1);
 return{ns,uses,decl,toks};
}
export function symsOf(t,fam){
 const o=new Set(),R=re=>{let m;while((m=re.exec(t))&&o.size<500)o.add(m[1])};
 switch(fam){
  case'c':R(/^[A-Za-z_][\w \t*]*?\b([A-Za-z_]\w*)[ \t]*\([^;{}()]*(?:\([^()]*\)[^;{}()]*)*\)[ \t\r\n]*\{/gm);break;
  case'py':R(/^[ \t]*(?:async[ \t]+)?(?:def|class)[ \t]+(\w+)/gm);break;
  case'js':R(/\b(?:function\*?[ \t]+|class[ \t]+)([A-Za-z_$][\w$]*)/g);R(/\b(?:const|let|var)[ \t]+([A-Za-z_$][\w$]*)[ \t]*=[ \t]*(?:async[ \t]*)?(?:\([^)]*\)|[\w$]+)[ \t]*=>/g);break;
  case'go':R(/^func[ \t]+(?:\([^)]*\)[ \t]*)?(\w+)/gm);break;
  case'rs':R(/\bfn[ \t]+(\w+)/g);break;
  case'jvm':R(/\b(?:class|interface|enum|object)[ \t]+([A-Z]\w*)/g);break;
 }
 const KW=new Set(['if','for','while','switch','return','sizeof','main','init','get','set']);return[...o].filter(n=>!KW.has(n)&&n.length>2);
}

// ============================================================
// LAB 6 — Switch Cisco L2 · MAC Learning, VLANs, Trunk, STP, Port Security
// ============================================================

const VLAN_COLORS = { 10:'#3b82f6', 20:'#10b981', 30:'#f59e0b', 40:'#a78bfa' };
const VLAN_NAMES  = { 10:'Administración', 20:'Médicos', 30:'Enfermería', 40:'Servidores' };

const NODE_ICONS = {
  switch:'../icons/switch.png', switch2:'../icons/switch.png',
  router:'../icons/router.png', pc:'../icons/pc.png',
  server:'../icons/server.png', laptop:'../icons/workstation.png',
};

const STEPS = {
  1:{ title:'Paso 1 — Topología',
      desc:'Arrastra 1 SW-Core + al menos 3 PCs o Servidores (uno por VLAN). Opcionalmente agrega switches adicionales.' },
  2:{ title:'Paso 2 — Conexiones',
      desc:'Usa 🔗 Conectar para enlazar todos los dispositivos al SW-Core. Si hay varios switches usa 🔀 Trunk entre ellos.' },
  3:{ title:'Paso 3 — Asignar VLANs',
      desc:'Arrastra las etiquetas VLAN sobre los dispositivos finales (PCs, Servidores). Cada uno debe tener su VLAN.' },
  4:{ title:'Paso 4 — VLANs & STP en CLI',
      desc:'Abre el Switch CLI (⌨). Crea las VLANs con nombre, configura puertos de acceso y activa Rapid-PVST.' },
  5:{ title:'Paso 5 — Port Security',
      desc:'En el CLI configura Port Security en los puertos de acceso: max-mac 2, violation shutdown. Luego ejecuta el Test.' },
};

// ── STATE ──────────────────────────────────────────────────
const st = {
  step:1, nodes:[], links:[], tool:'select',
  connecting:null, mouseX:0, mouseY:0,
  nodeCount:0, linkCount:0, completedSteps:[],
  cliHistory:[], cliHistIdx:-1,
  cliMode:'user', cliVlan:null, cliIf:null,
  vlans:{}, portAccess:{}, portTrunks:new Set(),
  portSecurity:{}, stpMode:null, macTable:[], testDone:false,
};

// ── DRAG FROM PANEL ────────────────────────────────────────
let dragData = null;
document.querySelectorAll('.device-item,.vlan-badge').forEach(el => {
  el.addEventListener('dragstart', e => {
    dragData = el.dataset.type
      ? { kind:'device', type:el.dataset.type, label:el.dataset.label }
      : { kind:'vlan', vlan:parseInt(el.dataset.vlan), vname:el.dataset.vname };
    e.dataTransfer.effectAllowed = 'copy';
  });
});

function onDragOver(e) { e.preventDefault(); e.dataTransfer.dropEffect='copy'; }
function onDrop(e) {
  e.preventDefault();
  if (!dragData) return;
  const canvas = document.getElementById('canvas');
  const rect = canvas.getBoundingClientRect();
  const x = e.clientX-rect.left-40, y = e.clientY-rect.top-40;
  if (dragData.kind==='device') addNode(dragData.type, dragData.label, x, y);
  else {
    const t = findClosestNode(e.clientX-rect.left, e.clientY-rect.top);
    if (t) assignVlan(t.id, dragData.vlan, dragData.vname);
    else showToast('Suelta la VLAN sobre un dispositivo','warn');
  }
  dragData=null; render();
}
function findClosestNode(x,y){
  let best=null,bd=80;
  st.nodes.forEach(n=>{const d=Math.hypot((n.x+40)-x,(n.y+40)-y);if(d<bd){bd=d;best=n;}});
  return best;
}

// ── NODES ──────────────────────────────────────────────────
function addNode(type, label, x, y){
  const id='n'+(++st.nodeCount);
  const count=st.nodes.filter(n=>n.type===type).length+1;
  const lbl=type==='switch'&&count===1?'SW-Core':label+(count>1?' '+count:'');
  st.nodes.push({id,type,label:lbl,x,y,vlan:null,vname:null});
  if(['pc','server','laptop'].includes(type)){
    const mac=Array.from({length:6},()=>Math.floor(Math.random()*256).toString(16).padStart(2,'0')).join(':');
    st.macTable.push({mac,nodeId:id,port:'fa0/'+(st.macTable.length+1),vlan:null});
  }
}
function assignVlan(nodeId, vlan, vname){
  const n=st.nodes.find(n=>n.id===nodeId);
  if(!n)return;
  if(['switch','switch2','router'].includes(n.type)){showToast('Asigna VLANs solo a PCs/Servidores','warn');return;}
  n.vlan=vlan; n.vname=vname;
  const entry=st.macTable.find(m=>m.nodeId===nodeId);
  if(entry) entry.vlan=vlan;
  showToast(`VLAN ${vlan} — ${VLAN_NAMES[vlan]} asignada a ${n.label}`,'ok');
}
function deleteNode(id){
  st.nodes=st.nodes.filter(n=>n.id!==id);
  st.links=st.links.filter(l=>l.from!==id&&l.to!==id);
  st.macTable=st.macTable.filter(m=>m.nodeId!==id);
  render();
}

// ── LINKS ──────────────────────────────────────────────────
function addLink(fromId, toId, trunk=false){
  if(st.links.find(l=>(l.from===fromId&&l.to===toId)||(l.from===toId&&l.to===fromId))){showToast('Enlace ya existe','warn');return;}
  st.links.push({id:'l'+(++st.linkCount),from:fromId,to:toId,trunk});
  if(trunk) showToast('Trunk 802.1Q creado','ok');
}
function deleteLink(id){st.links=st.links.filter(l=>l.id!==id);render();}

// ── TOOL SYSTEM ────────────────────────────────────────────
function setTool(t){
  st.tool=t; st.connecting=null;
  document.getElementById('canvas').classList.toggle('connecting',t==='connect'||t==='trunk');
  ['toolSelect','toolConnect','toolTrunk'].forEach(id=>{const b=document.getElementById(id);if(b)b.classList.remove('active');});
  const b=document.getElementById({select:'toolSelect',connect:'toolConnect',trunk:'toolTrunk'}[t]);
  if(b) b.classList.add('active');
  document.getElementById('toolHint').textContent=
    {select:'Arrastra para mover',connect:'Clic en origen → destino',trunk:'Switch → Switch para Trunk'}[t]||'';
  removeTempLine(); render();
}

// ── NODE DRAG ON CANVAS ────────────────────────────────────
let draggingNode=null,dragOffX=0,dragOffY=0,tempLine=null;
function onNodeMouseDown(e,id){
  if(st.tool!=='select'){onNodeClick(id);return;}
  e.stopPropagation(); draggingNode=id;
  const n=st.nodes.find(n=>n.id===id);
  const r=document.getElementById('canvas').getBoundingClientRect();
  dragOffX=e.clientX-r.left-n.x; dragOffY=e.clientY-r.top-n.y; e.preventDefault();
}
document.addEventListener('mousemove',e=>{
  if(!draggingNode)return;
  const r=document.getElementById('canvas').getBoundingClientRect();
  const n=st.nodes.find(n=>n.id===draggingNode);
  if(n){n.x=Math.max(0,e.clientX-r.left-dragOffX);n.y=Math.max(0,e.clientY-r.top-dragOffY);render();}
});
document.addEventListener('mouseup',()=>{draggingNode=null;});
function onMouseMove(e){
  const r=e.currentTarget.getBoundingClientRect();
  st.mouseX=e.clientX-r.left; st.mouseY=e.clientY-r.top;
  if(st.connecting)updateTempLine();
}
function onNodeClick(id){
  if(st.tool==='select')return;
  if(!st.connecting){st.connecting=id;document.getElementById('toolHint').textContent='Clic en destino';render();return;}
  if(st.connecting===id){st.connecting=null;removeTempLine();render();return;}
  addLink(st.connecting,id,st.tool==='trunk');
  st.connecting=null;removeTempLine();render();
}
function onCanvasClick(e){
  if(e.target.id==='canvas'||e.target.id==='svg-layer'){st.connecting=null;removeTempLine();render();}
}
function updateTempLine(){
  const svg=document.getElementById('svg-layer');
  const from=st.nodes.find(n=>n.id===st.connecting); if(!from)return;
  if(!tempLine){tempLine=document.createElementNS('http://www.w3.org/2000/svg','line');tempLine.classList.add('connecting-line');svg.appendChild(tempLine);}
  tempLine.setAttribute('x1',from.x+36);tempLine.setAttribute('y1',from.y+36);
  tempLine.setAttribute('x2',st.mouseX);tempLine.setAttribute('y2',st.mouseY);
}
function removeTempLine(){if(tempLine){tempLine.remove();tempLine=null;}}

// ── RENDER ─────────────────────────────────────────────────
function render(){renderLinks();renderNodes();updateStatus();renderCheckList();}

function renderNodes(){
  const canvas=document.getElementById('canvas');
  canvas.querySelectorAll('.node').forEach(n=>n.remove());
  st.nodes.forEach(node=>{
    const el=document.createElement('div');
    el.className='node'; el.id='node-'+node.id;
    el.style.left=node.x+'px'; el.style.top=node.y+'px';
    const vc=node.vlan?VLAN_COLORS[node.vlan]:null;
    const border=node.id===st.connecting?'var(--warn)':(vc||'var(--border)');
    const shadow=node.id===st.connecting?'0 0 16px rgba(245,158,11,.6)':(vc?`0 0 12px ${vc}44`:'none');
    const src=NODE_ICONS[node.type]||'../icons/switch.png';
    el.innerHTML=`
      <div class="node-box" style="border-color:${border};box-shadow:${shadow}"
        onmousedown="onNodeMouseDown(event,'${node.id}')">
        <button class="node-delete" onclick="event.stopPropagation();deleteNode('${node.id}')">✕</button>
        <span class="node-icon"><img src="${src}" alt="${node.type}" onerror="this.outerHTML='<span style=\\"font-size:28px\\">📦</span>'"></span>
        <span class="node-label">${node.label}</span>
        ${node.vlan?`<span class="node-vlan" style="background:${vc}">${node.vname||'VLAN '+node.vlan}</span>`:''}
      </div>`;
    el.addEventListener('click',e=>{e.stopPropagation();onNodeClick(node.id);});
    canvas.appendChild(el);
  });
}

function renderLinks(){
  const svg=document.getElementById('svg-layer');
  svg.innerHTML='';
  st.links.forEach(link=>{
    const from=st.nodes.find(n=>n.id===link.from);
    const to=st.nodes.find(n=>n.id===link.to);
    if(!from||!to)return;
    const x1=from.x+36,y1=from.y+36,x2=to.x+36,y2=to.y+36;
    const hit=document.createElementNS('http://www.w3.org/2000/svg','line');
    hit.setAttribute('x1',x1);hit.setAttribute('y1',y1);hit.setAttribute('x2',x2);hit.setAttribute('y2',y2);
    hit.classList.add('link-delete');
    hit.addEventListener('click',()=>{if(confirm('¿Eliminar enlace?'))deleteLink(link.id);});
    svg.appendChild(hit);
    const line=document.createElementNS('http://www.w3.org/2000/svg','line');
    line.setAttribute('x1',x1);line.setAttribute('y1',y1);line.setAttribute('x2',x2);line.setAttribute('y2',y2);
    line.classList.add('link-line');
    if(link.trunk) line.classList.add('trunk');
    else if(from.vlan&&from.vlan===to.vlan){line.style.stroke=VLAN_COLORS[from.vlan];line.style.strokeWidth='2.5';}
    svg.appendChild(line);
    if(link.trunk){
      const mx=(x1+x2)/2,my=(y1+y2)/2;
      const txt=document.createElementNS('http://www.w3.org/2000/svg','text');
      txt.setAttribute('x',mx);txt.setAttribute('y',my-6);
      txt.setAttribute('text-anchor','middle');txt.setAttribute('font-size','9');
      txt.setAttribute('fill','#06b6d4');txt.textContent='TRUNK';
      svg.appendChild(txt);
    }
  });
  if(tempLine)svg.appendChild(tempLine);
}

// ── STATUS ─────────────────────────────────────────────────
function updateStatus(){
  const sw=st.nodes.filter(n=>n.type==='switch'||n.type==='switch2').length;
  const hosts=st.nodes.filter(n=>['pc','server','laptop'].includes(n.type)).length;
  const vlansSet=[...new Set(st.nodes.filter(n=>n.vlan).map(n=>n.vlan))].length;
  document.getElementById('netStatus').innerHTML=`
    <div style="font-size:11px;display:flex;flex-direction:column;gap:4px">
      <div>🔀 Switches: <b>${sw}</b></div>
      <div>💻 Hosts: <b>${hosts}</b></div>
      <div>🏷️ VLANs asignadas: <b>${vlansSet}</b></div>
      <div>📋 VLANs CLI: <b>${Object.keys(st.vlans).length}</b></div>
      <div>🔌 Puertos access: <b>${Object.keys(st.portAccess).length}</b></div>
      <div>🔒 Port Security: <b>${Object.keys(st.portSecurity).length}</b></div>
      <div>🌳 STP: <b>${st.stpMode||'—'}</b></div>
      <div>📊 MACs: <b>${st.macTable.length}</b></div>
    </div>`;
}

function renderCheckList(){
  const items=[
    {label:'SW-Core en canvas',        ok:st.nodes.some(n=>n.type==='switch')},
    {label:'≥ 3 dispositivos finales',  ok:st.nodes.filter(n=>['pc','server','laptop'].includes(n.type)).length>=3},
    {label:'Todo conectado',            ok:allConnected()},
    {label:'VLANs asignadas (≥2)',      ok:[...new Set(st.nodes.filter(n=>n.vlan).map(n=>n.vlan))].length>=2},
    {label:'VLANs nombradas en CLI',    ok:Object.keys(st.vlans).length>=2},
    {label:'Puertos access config',     ok:Object.keys(st.portAccess).length>=2},
    {label:'STP configurado',           ok:!!st.stpMode},
    {label:'Port Security activo',      ok:Object.keys(st.portSecurity).length>=1},
    {label:'Test MAC/VLAN OK',          ok:st.testDone},
  ];
  document.getElementById('checkList').innerHTML=
    items.map(i=>`<div class="check-item ${i.ok?'ok':'err'}">${i.label}</div>`).join('');
}

function allConnected(){
  if(st.nodes.length<2)return false;
  if(!st.nodes.some(n=>n.type==='switch'))return false;
  return st.nodes.filter(n=>['pc','server','laptop'].includes(n.type))
    .every(pc=>st.links.some(l=>l.from===pc.id||l.to===pc.id));
}

// ── STEP NAV ───────────────────────────────────────────────
function goStep(n){
  st.step=n;
  document.getElementById('progressFill').style.width=Math.round(n/5*100)+'%';
  document.getElementById('stepTitle').textContent=STEPS[n].title;
  document.getElementById('stepDesc').textContent=STEPS[n].desc;
  for(let i=1;i<=5;i++){
    const b=document.getElementById('sBtn'+i);
    b.classList.remove('active','done');
    if(i===n) b.classList.add('active');
    else if(st.completedSteps.includes(i)) b.classList.add('done');
  }
  if(n>=4) document.getElementById('cliBtn').classList.add('visible','pulse');
  else     document.getElementById('cliBtn').classList.remove('visible','pulse');
}

function validateStep(){
  const n=st.step;
  const hosts=st.nodes.filter(nd=>['pc','server','laptop'].includes(nd.type));
  if(n===1){
    if(!st.nodes.some(nd=>nd.type==='switch')){showToast('Arrastra el SW-Core al canvas','err');return;}
    if(hosts.length<3){showToast('Necesitas al menos 3 dispositivos finales','err');return;}
    completeStep(1);goStep(2);
  } else if(n===2){
    if(!allConnected()){showToast('Conecta todos los dispositivos al SW-Core','err');return;}
    completeStep(2);goStep(3);
  } else if(n===3){
    const vlansA=[...new Set(hosts.filter(nd=>nd.vlan).map(nd=>nd.vlan))];
    if(vlansA.length<2){showToast('Asigna al menos 2 VLANs distintas','err');return;}
    if(hosts.some(nd=>!nd.vlan)){showToast('Todos los hosts deben tener VLAN asignada','err');return;}
    completeStep(3);goStep(4);
  } else if(n===4){
    if(Object.keys(st.vlans).length<2){showToast('Crea al menos 2 VLANs con nombre en el CLI','err');return;}
    if(Object.keys(st.portAccess).length<2){showToast('Configura al menos 2 puertos de acceso','err');return;}
    if(!st.stpMode){showToast('Ejecuta: spanning-tree mode rapid-pvst','err');return;}
    completeStep(4);goStep(5);
  } else if(n===5){
    if(!Object.keys(st.portSecurity).length){showToast('Configura Port Security en al menos 1 puerto','err');return;}
    if(!st.testDone){showToast('Ejecuta el MAC/Ping Test para verificar','err');return;}
    completeStep(5);showCompletion();
  }
}

function completeStep(n){if(!st.completedSteps.includes(n))st.completedSteps.push(n);showToast(`Paso ${n} completado ✓`,'ok');}
function clearCanvas(){
  if(!confirm('¿Limpiar el canvas?'))return;
  st.nodes=[];st.links=[];st.macTable=[];st.connecting=null;removeTempLine();render();
}

// ── CLI SWITCH IOS ─────────────────────────────────────────
function cliPrompt(){
  if(st.cliMode==='user')      return 'SW-Core>';
  if(st.cliMode==='priv')      return 'SW-Core#';
  if(st.cliMode==='conf')      return 'SW-Core(config)#';
  if(st.cliMode==='conf-vlan') return 'SW-Core(config-vlan)#';
  if(st.cliMode==='conf-if')   return 'SW-Core(config-if)#';
  return 'SW-Core>';
}
function cliPrint(text,cls=''){
  const out=document.getElementById('cliOutput');
  const d=document.createElement('div');
  if(cls) d.style.color=({ok:'#10b981',err:'#ef4444',warn:'#f59e0b',info:'#3b82f6',muted:'#64748b'})[cls]||'';
  d.textContent=text; out.appendChild(d); out.scrollTop=out.scrollHeight;
}
function toggleCLI(){
  const ov=document.getElementById('cliOverlay');
  const open=ov.classList.toggle('open');
  if(open){
    if(!document.getElementById('cliOutput').children.length){
      cliPrint('Cisco IOS Software — SW-Core · Catalyst Series');
      cliPrint('Clínica San Rafael · Lab 6 · Switch L2');cliPrint('');
      cliPrint('Flujo: enable → conf t → vlan 10 → name Admin → exit','muted');
      cliPrint('       int fa0/1 → sw mode access → sw access vlan 10','muted');
      cliPrint('       spanning-tree mode rapid-pvst','muted');
      cliPrint('       port-security max 2 → port-security violation shutdown','muted');
    }
    document.getElementById('cliInput').focus();
  }
}
function closeCLI(){document.getElementById('cliOverlay').classList.remove('open');}

function onCLI(e){
  if(e.key==='ArrowUp'){if(st.cliHistIdx<st.cliHistory.length-1){st.cliHistIdx++;e.target.value=st.cliHistory[st.cliHistory.length-1-st.cliHistIdx]||'';}return;}
  if(e.key==='ArrowDown'){if(st.cliHistIdx>0){st.cliHistIdx--;e.target.value=st.cliHistory[st.cliHistory.length-1-st.cliHistIdx]||'';}else{st.cliHistIdx=-1;e.target.value='';}return;}
  if(e.key!=='Enter')return;
  const raw=e.target.value.trim(); if(!raw)return;
  st.cliHistory.push(raw); st.cliHistIdx=-1;
  cliPrint(`${cliPrompt()} ${raw}`,'muted');
  e.target.value='';
  processCmd(raw.toLowerCase().replace(/\s+/g,' '));
  document.getElementById('cliPromptLbl').textContent=cliPrompt();
}

function processCmd(cmd){
  const m=st.cliMode;
  if(cmd==='exit'||cmd==='end'){
    st.cliMode={'priv':'user','conf':'priv','conf-vlan':'conf','conf-if':'conf'}[m]||'user';
    st.cliVlan=null; st.cliIf=null; cliPrint(''); return;
  }
  if(m==='user'){
    if(cmd==='enable'||cmd==='en'){st.cliMode='priv';cliPrint('');return;}
    cliPrint('% Unknown command','err');return;
  }
  if(m==='priv'){
    if(cmd==='configure terminal'||cmd==='conf t'){st.cliMode='conf';cliPrint('Enter configuration commands, one per line.');return;}
    if(cmd==='show mac address-table'||cmd==='sh mac addr'||cmd==='show mac-address-table'){
      cliPrint('VLAN  MAC Address         Type    Port');
      cliPrint('----  ------------------  ------  ------');
      if(!st.macTable.length){cliPrint('(vacía — conecta y asigna VLANs a los hosts)','muted');return;}
      st.macTable.forEach(e=>cliPrint(`${String(e.vlan||'—').padEnd(5)} ${e.mac.padEnd(20)} DYNAMIC ${e.port}`,e.vlan?'ok':'muted'));
      return;
    }
    if(cmd==='show vlan brief'||cmd==='sh vlan br'){
      cliPrint('VLAN  Name                 Status   Ports');
      cliPrint('----  -------------------  -------- -----');
      cliPrint('1     default              active   (sin asignar)','muted');
      Object.entries(st.vlans).forEach(([id,v])=>{
        const ports=Object.entries(st.portAccess).filter(([,vid])=>vid===parseInt(id)).map(([p])=>p).join(', ');
        cliPrint(`${String(id).padEnd(5)} ${(v.name||'VLAN'+id).padEnd(20)} active   ${ports||'—'}`,v.name?'ok':'muted');
      });
      return;
    }
    if(cmd.startsWith('show spanning-tree')||cmd.startsWith('sh span')){
      if(!st.stpMode){cliPrint('Spanning tree: default PVST (no configurado explícitamente)','warn');return;}
      cliPrint(`Mode: ${st.stpMode.toUpperCase()}`,'ok');
      cliPrint('Root Bridge: SW-Core  Priority: 32768  State: Forwarding','ok');return;
    }
    if(cmd.startsWith('show port-security')||cmd.startsWith('sh port-sec')){
      if(!Object.keys(st.portSecurity).length){cliPrint('No port security configured.','warn');return;}
      cliPrint('Interface  MaxMac  Violation   Status');
      Object.entries(st.portSecurity).forEach(([p,s])=>{
        cliPrint(`${p.padEnd(11)}${String(s.max).padEnd(8)}${s.violation.padEnd(12)}Secure-up`,'ok');
      });
      return;
    }
    if(cmd.startsWith('show run')||cmd.startsWith('sh run')){
      cliPrint('hostname SW-Core');cliPrint('!');
      Object.entries(st.vlans).forEach(([id,v])=>{cliPrint(`vlan ${id}`);if(v.name)cliPrint(` name ${v.name}`);cliPrint('!');});
      Object.entries(st.portAccess).forEach(([p,v])=>{cliPrint(`interface ${p}`);cliPrint(` switchport mode access`);cliPrint(` switchport access vlan ${v}`);cliPrint('!');});
      if(st.stpMode)cliPrint(`spanning-tree mode ${st.stpMode}`);
      return;
    }
    cliPrint('% Unknown command','err');return;
  }
  if(m==='conf'){
    const vlanM=cmd.match(/^vlan\s+(\d+)$/);
    if(vlanM){st.cliVlan=parseInt(vlanM[1]);if(!st.vlans[st.cliVlan])st.vlans[st.cliVlan]={};st.cliMode='conf-vlan';cliPrint(`Configurando VLAN ${st.cliVlan}.`,'info');return;}
    const ifM=cmd.match(/^(int(?:erface)?)\s+(fa\d+\/\d+|gi\d+\/\d+|e\d+\/\d+|eth\d+\/\d+)$/);
    if(ifM){st.cliIf=ifM[2];st.cliMode='conf-if';cliPrint(`Interfaz ${st.cliIf}.`,'info');return;}
    if(cmd.includes('spanning-tree mode')){
      st.stpMode=cmd.includes('rapid')?'rapid-pvst':'pvst';
      cliPrint(`STP mode: ${st.stpMode}.`,'ok');render();return;
    }
    cliPrint('% Unknown command. Ej: vlan 10 / interface fa0/1 / spanning-tree mode rapid-pvst','err');return;
  }
  if(m==='conf-vlan'){
    const nameM=cmd.match(/^name\s+(.+)$/);
    if(nameM){st.vlans[st.cliVlan].name=nameM[1];cliPrint(`VLAN ${st.cliVlan} → nombre "${nameM[1]}".`,'ok');render();return;}
    cliPrint('% Comando: name <NombreVLAN>','err');return;
  }
  if(m==='conf-if'){
    if(cmd==='sw mode access'||cmd==='switchport mode access'||cmd==='sw mode acc'){cliPrint(`${st.cliIf}: modo access.`,'ok');return;}
    if(cmd==='sw mode trunk'||cmd==='switchport mode trunk'){st.portTrunks.add(st.cliIf);cliPrint(`${st.cliIf}: modo trunk.`,'ok');return;}
    const accM=cmd.match(/^(sw(?:itchport)?\s+access\s+vlan|sw\s+acc\s+vlan)\s+(\d+)$/);
    if(accM){st.portAccess[st.cliIf]=parseInt(accM[2]);cliPrint(`${st.cliIf}: access VLAN ${accM[2]}.`,'ok');render();return;}
    const psMaxM=cmd.match(/^(?:sw(?:itchport)?\s+)?port-security\s+(?:max(?:imum)?)\s+(\d+)$/);
    if(psMaxM){if(!st.portSecurity[st.cliIf])st.portSecurity[st.cliIf]={max:2,violation:'shutdown'};st.portSecurity[st.cliIf].max=parseInt(psMaxM[1]);cliPrint(`${st.cliIf}: port-security max ${psMaxM[1]}.`,'ok');render();return;}
    const psViolM=cmd.match(/^(?:sw(?:itchport)?\s+)?port-security\s+violation\s+(shutdown|restrict|protect)$/);
    if(psViolM){if(!st.portSecurity[st.cliIf])st.portSecurity[st.cliIf]={max:2,violation:'shutdown'};st.portSecurity[st.cliIf].violation=psViolM[1];cliPrint(`${st.cliIf}: violation ${psViolM[1]}.`,'ok');render();return;}
    if(cmd==='port-security'||cmd==='sw port-security'||cmd==='switchport port-security'){if(!st.portSecurity[st.cliIf])st.portSecurity[st.cliIf]={max:2,violation:'shutdown'};cliPrint(`${st.cliIf}: port-security habilitado.`,'ok');render();return;}
    cliPrint('% Ej: sw mode access, sw access vlan 10, port-security max 2, port-security violation shutdown','err');
  }
}

// ── MAC / PING TEST ────────────────────────────────────────
function openPingModal(){document.getElementById('pingModal').classList.add('show');}
function closePing(){document.getElementById('pingModal').classList.remove('show');}

function runPingTest(){
  const out=document.getElementById('pingOutput'); out.innerHTML='';
  const add=(t,c)=>{const d=document.createElement('div');d.className='ping-'+c;d.textContent=t;out.appendChild(d);};
  const hosts=st.nodes.filter(n=>['pc','server','laptop'].includes(n.type)&&n.vlan);
  if(hosts.length<2){add('✗ Necesitas al menos 2 hosts con VLAN asignada.','err');return;}
  add('--- Tabla MAC Address ---','info');
  if(st.macTable.length){
    st.macTable.forEach(e=>add(`VLAN ${e.vlan||'—'}  ${e.mac}  ${e.port}`,e.vlan?'ok':'err'));
  } else { add('(vacía)','err'); }
  add('','info');
  add('--- Aislamiento VLAN ---','info');
  let pass=0,fail=0;
  for(let i=0;i<hosts.length;i++){
    for(let j=i+1;j<hosts.length;j++){
      const a=hosts[i],b=hosts[j];
      if(a.vlan===b.vlan){
        add(`${a.label} ↔ ${b.label} (VLAN ${a.vlan}) ... OK ✓`,'ok');pass++;
      } else {
        add(`${a.label} (V${a.vlan}) ↔ ${b.label} (V${b.vlan}) ... BLOQUEADO ✗`,'err');fail++;
      }
    }
  }
  add('','info');
  if(pass>0&&Object.keys(st.portAccess).length>=1){
    add(`✓ ${pass} pings intra-VLAN OK · ${fail} cross-VLAN bloqueados.`,'ok');
    st.testDone=true; render();
  } else {
    add('⚠ Configura puertos de acceso en el CLI primero.','err');
  }
}

// ── COMPLETION ─────────────────────────────────────────────
function showCompletion(){
  document.getElementById('cst-dev').textContent=st.nodes.length;
  document.getElementById('cst-mac').textContent=st.macTable.length;
  document.getElementById('compOverlay').classList.add('show');
  launchConfetti(document.getElementById('compCard'));
}
function launchConfetti(c){
  const colors=['#06b6d4','#10b981','#3b82f6','#a78bfa','#f59e0b'];
  for(let i=0;i<55;i++){
    const p=document.createElement('div');p.className='confetti-p';
    p.style.cssText=`left:${Math.random()*100}%;top:${Math.random()*30-10}%;width:${6+Math.random()*6}px;height:${6+Math.random()*6}px;background:${colors[Math.floor(Math.random()*colors.length)]};animation:confettiFall ${1.5+Math.random()*2}s ${Math.random()*.8}s ease-out forwards`;
    c.appendChild(p);setTimeout(()=>p.remove(),4000);
  }
}

let toastTimer;
function showToast(msg,type='ok'){
  const t=document.getElementById('toast');
  t.textContent=msg;
  t.style.background={ok:'#10b981',err:'#ef4444',warn:'#f59e0b'}[type]||'#10b981';
  t.classList.add('show'); clearTimeout(toastTimer);
  toastTimer=setTimeout(()=>t.classList.remove('show'),2800);
}

goStep(1); render();

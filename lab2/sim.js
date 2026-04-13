// ============================================================
// LAB 2 — Router-on-a-Stick · Inter-VLAN Routing 802.1Q
// ============================================================

const VLAN_COLORS = { 10:'#3b82f6', 20:'#10b981', 30:'#f59e0b' };

const EMOJIS = { router:'📡', switch:'🔀', pc:'💻', server:'🖥️', laptop:'🖱️', ap:'📶', printer:'🖨️' };
function imgFallback(img) {
  const s = document.createElement('span');
  s.style.fontSize = '26px'; s.style.lineHeight = '1';
  s.textContent = EMOJIS[img.dataset.type] || '📦';
  img.replaceWith(s);
}
const VLAN_NAMES  = { 10:'Administración', 20:'Médicos', 30:'Enfermería' };
const VLAN_NETS   = { 10:'10.10.10', 20:'10.10.20', 30:'10.10.30' };

const NODE_ICONS = {
  router:  '../icons/router.png',
  switch:  '../icons/switch.png',
  pc:      '../icons/pc.png',
  server:  '../icons/server.png',
  laptop:  '../icons/workstation.png',
};

const STEPS = {
  1: { title:'Paso 1 — Topología Base',
       desc:'Arrastra al canvas: 1 Router + 1 Switch L2 + al menos 3 PCs (uno por VLAN).' },
  2: { title:'Paso 2 — Conexiones',
       desc:'Conecta los PCs al switch (🔗 Conectar). Luego conecta el switch al router con enlace Trunk (🔀 Trunk 802.1Q).' },
  3: { title:'Paso 3 — Asignación de VLANs',
       desc:'Arrastra las etiquetas VLAN sobre cada PC: VLAN 10 a Admin, VLAN 20 a Médicos, VLAN 30 a Enfermería.' },
  4: { title:'Paso 4 — Sub-interfaces del Router',
       desc:'Abre el Router CLI (⌨) y configura las sub-interfaces fa0/0.10, fa0/0.20 y fa0/0.30 con encapsulation dot1Q e IP gateway.' },
  5: { title:'Paso 5 — Verificación',
       desc:'Ejecuta el Ping Test para confirmar que el router enruta entre las 3 VLANs. ¡El routing debe funcionar!' },
};

// ── STATE ──────────────────────────────────────────────────
let state = {
  step: 1,
  nodes: [],
  links: [],
  tool: 'select',
  connecting: null,
  mouseX: 0, mouseY: 0,
  nodeCount: 0, linkCount: 0,
  completedSteps: [],
  cliHistory: [],
  cliHistIdx: -1,
  // CLI state
  cliMode: 'user',          // user | priv | conf | conf-subif
  cliSubif: null,           // current sub-interface id (e.g. "fa0/0.10")
  configuredSubifs: {},     // { "fa0/0.10": { encap:10, ip:'10.10.10.1', active:true } }
  pingDone: false,
};

// ── DRAG FROM PANEL ────────────────────────────────────────
let dragData = null;

document.querySelectorAll('.device-item, .vlan-badge').forEach(el => {
  el.addEventListener('dragstart', e => {
    dragData = el.dataset.type
      ? { kind:'device', type:el.dataset.type, label:el.dataset.label, icon:el.dataset.icon }
      : { kind:'vlan', vlan:parseInt(el.dataset.vlan), vname:el.dataset.vname };
    e.dataTransfer.effectAllowed = 'copy';
  });
});

function onDragOver(e) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }

function onDrop(e) {
  e.preventDefault();
  if (!dragData) return;
  const canvas = document.getElementById('canvas');
  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left - 40;
  const y = e.clientY - rect.top  - 40;

  if (dragData.kind === 'device') {
    addNode(dragData.type, dragData.label, x, y);
  } else {
    const target = findClosestNode(e.clientX - rect.left, e.clientY - rect.top);
    if (target) assignVlan(target.id, dragData.vlan, dragData.vname);
    else showToast('Suelta la VLAN sobre un dispositivo', 'warn');
  }
  dragData = null;
  render();
}

function findClosestNode(x, y) {
  let best = null, bestDist = 80;
  state.nodes.forEach(n => {
    const d = Math.hypot((n.x+40)-x, (n.y+40)-y);
    if (d < bestDist) { bestDist = d; best = n; }
  });
  return best;
}

// ── NODES ──────────────────────────────────────────────────
function addNode(type, label, x, y) {
  const id = 'n' + (++state.nodeCount);
  const count = state.nodes.filter(n => n.type === type).length + 1;
  state.nodes.push({ id, type, label: label+(count>1?' '+count:''), x, y, vlan:null, vname:null });
}

function assignVlan(nodeId, vlan, vname) {
  const n = state.nodes.find(n => n.id === nodeId);
  if (!n) return;
  if (n.type === 'router' || n.type === 'switch') {
    showToast('Asigna VLANs a los PCs/Servidores, no al router/switch', 'warn'); return;
  }
  n.vlan = vlan; n.vname = vname;
  showToast(`VLAN ${vlan} — ${VLAN_NAMES[vlan]} asignada a ${n.label}`, 'ok');
}

function deleteNode(id) {
  state.nodes = state.nodes.filter(n => n.id !== id);
  state.links = state.links.filter(l => l.from !== id && l.to !== id);
  render();
}

// ── LINKS ──────────────────────────────────────────────────
function addLink(fromId, toId, trunk = false) {
  if (state.links.find(l => (l.from===fromId&&l.to===toId)||(l.from===toId&&l.to===fromId))) {
    showToast('Ya existe un enlace entre estos dispositivos', 'warn'); return;
  }
  state.links.push({ id:'l'+(++state.linkCount), from:fromId, to:toId, trunk });
  if (trunk) showToast('Enlace Trunk 802.1Q creado', 'ok');
}

function deleteLink(id) {
  state.links = state.links.filter(l => l.id !== id);
  render();
}

// ── TOOL SYSTEM ────────────────────────────────────────────
function setTool(t) {
  state.tool = t;
  state.connecting = null;
  const canvas = document.getElementById('canvas');
  canvas.classList.toggle('connecting', t==='connect'||t==='trunk');
  ['toolSelect','toolConnect','toolTrunk'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.remove('active');
  });
  const map = { select:'toolSelect', connect:'toolConnect', trunk:'toolTrunk' };
  const btn = document.getElementById(map[t]);
  if (btn) btn.classList.add('active');
  const hints = {
    select: 'Arrastra dispositivos para moverlos',
    connect: 'Clic en origen → clic en destino para conectar',
    trunk:   'Clic en el switch → clic en el router para crear un Trunk',
  };
  document.getElementById('toolHint').textContent = hints[t] || '';
  removeTempLine();
  render();
}

// ── NODE DRAGGING ON CANVAS ────────────────────────────────
let draggingNode = null, dragOffX = 0, dragOffY = 0;
let tempLine = null;

function onNodeMouseDown(e, id) {
  if (state.tool !== 'select') { onNodeClick(id); return; }
  e.stopPropagation();
  draggingNode = id;
  const node = state.nodes.find(n => n.id === id);
  const rect = document.getElementById('canvas').getBoundingClientRect();
  dragOffX = e.clientX - rect.left - node.x;
  dragOffY = e.clientY - rect.top  - node.y;
  e.preventDefault();
}

document.addEventListener('mousemove', e => {
  if (!draggingNode) return;
  const rect = document.getElementById('canvas').getBoundingClientRect();
  const node = state.nodes.find(n => n.id === draggingNode);
  if (node) {
    node.x = Math.max(0, e.clientX - rect.left - dragOffX);
    node.y = Math.max(0, e.clientY - rect.top  - dragOffY);
    render();
  }
});
document.addEventListener('mouseup', () => { draggingNode = null; });

function onMouseMove(e) {
  const rect = e.currentTarget.getBoundingClientRect();
  state.mouseX = e.clientX - rect.left;
  state.mouseY = e.clientY - rect.top;
  if (state.connecting) updateTempLine();
}

// ── CONNECT TOOL ───────────────────────────────────────────
function onNodeClick(id) {
  if (state.tool === 'select') return;
  if (!state.connecting) {
    state.connecting = id;
    document.getElementById('toolHint').textContent = 'Ahora clic en el dispositivo destino';
    render(); return;
  }
  if (state.connecting === id) { state.connecting = null; removeTempLine(); render(); return; }
  addLink(state.connecting, id, state.tool === 'trunk');
  state.connecting = null;
  removeTempLine();
  render();
}

function onCanvasClick(e) {
  if (e.target.id === 'canvas' || e.target.id === 'svg-layer') {
    state.connecting = null; removeTempLine(); render();
  }
}

function updateTempLine() {
  const svg = document.getElementById('svg-layer');
  const from = state.nodes.find(n => n.id === state.connecting);
  if (!from) return;
  if (!tempLine) {
    tempLine = document.createElementNS('http://www.w3.org/2000/svg','line');
    tempLine.classList.add('connecting-line');
    svg.appendChild(tempLine);
  }
  tempLine.setAttribute('x1', from.x+36); tempLine.setAttribute('y1', from.y+36);
  tempLine.setAttribute('x2', state.mouseX); tempLine.setAttribute('y2', state.mouseY);
}
function removeTempLine() { if (tempLine) { tempLine.remove(); tempLine = null; } }

// ── RENDER ─────────────────────────────────────────────────
function render() {
  renderLinks();
  renderNodes();
  updateStatus();
  renderCheckList();
}

function renderNodes() {
  const canvas = document.getElementById('canvas');
  canvas.querySelectorAll('.node').forEach(n => n.remove());
  state.nodes.forEach(node => {
    const el = document.createElement('div');
    el.className = 'node';
    el.id = 'node-' + node.id;
    el.style.left = node.x + 'px';
    el.style.top  = node.y + 'px';
    const vc = node.vlan ? VLAN_COLORS[node.vlan] : null;
    const border = node.id===state.connecting ? 'var(--warn)' : (vc || 'var(--border)');
    const shadow = node.id===state.connecting ? '0 0 16px rgba(245,158,11,.6)' : (vc ? `0 0 12px ${vc}44` : 'none');
    const iconSrc = NODE_ICONS[node.type];
    const iconHtml = iconSrc
      ? `<img src="${iconSrc}" data-type="${node.type}" alt="${node.type}" onerror="imgFallback(this)">`
      : `<span style="font-size:28px">${node.icon||'📦'}</span>`;
    el.innerHTML = `
      <div class="node-box" style="border-color:${border};box-shadow:${shadow}"
        onmousedown="onNodeMouseDown(event,'${node.id}')">
        <button class="node-delete" onclick="event.stopPropagation();deleteNode('${node.id}')">✕</button>
        <span class="node-icon">${iconHtml}</span>
        <span class="node-label">${node.label}</span>
        ${node.vlan ? `<span class="node-vlan" style="background:${vc}">${node.vname||'VLAN '+node.vlan}</span>` : ''}
      </div>`;
    el.addEventListener('click', e => { e.stopPropagation(); onNodeClick(node.id); });
    canvas.appendChild(el);
  });
}

function renderLinks() {
  const svg = document.getElementById('svg-layer');
  svg.innerHTML = '';
  state.links.forEach(link => {
    const from = state.nodes.find(n => n.id === link.from);
    const to   = state.nodes.find(n => n.id === link.to);
    if (!from||!to) return;
    const x1=from.x+36, y1=from.y+36, x2=to.x+36, y2=to.y+36;
    // hit area
    const hit = document.createElementNS('http://www.w3.org/2000/svg','line');
    hit.setAttribute('x1',x1); hit.setAttribute('y1',y1);
    hit.setAttribute('x2',x2); hit.setAttribute('y2',y2);
    hit.classList.add('link-delete');
    hit.addEventListener('click', () => { if(confirm('¿Eliminar enlace?')) deleteLink(link.id); });
    svg.appendChild(hit);
    // visible line
    const line = document.createElementNS('http://www.w3.org/2000/svg','line');
    line.setAttribute('x1',x1); line.setAttribute('y1',y1);
    line.setAttribute('x2',x2); line.setAttribute('y2',y2);
    line.classList.add('link-line');
    if (link.trunk) {
      line.classList.add('trunk');
    } else {
      const fv=from.vlan, tv=to.vlan;
      if (fv && fv===tv) { line.style.stroke=VLAN_COLORS[fv]; line.style.strokeWidth='2.5'; }
    }
    svg.appendChild(line);
    if (link.trunk) {
      const mx=(x1+x2)/2, my=(y1+y2)/2;
      const txt = document.createElementNS('http://www.w3.org/2000/svg','text');
      txt.setAttribute('x',mx); txt.setAttribute('y',my-6);
      txt.setAttribute('text-anchor','middle'); txt.setAttribute('font-size','9');
      txt.setAttribute('fill','#f59e0b'); txt.textContent='TRUNK 802.1Q';
      svg.appendChild(txt);
    }
  });
  if (tempLine) svg.appendChild(tempLine);
}

// ── STATUS / CHECKLIST ─────────────────────────────────────
function updateStatus() {
  const routers  = state.nodes.filter(n => n.type==='router').length;
  const switches = state.nodes.filter(n => n.type==='switch').length;
  const pcs      = state.nodes.filter(n => ['pc','server','laptop'].includes(n.type)).length;
  const trunks   = state.links.filter(l => l.trunk).length;
  const vlansAssigned = [...new Set(state.nodes.filter(n => n.vlan).map(n => n.vlan))].length;
  const subifCount = Object.values(state.configuredSubifs).filter(s => s.encap && s.ip && s.active).length;

  document.getElementById('netStatus').innerHTML = `
    <div style="font-size:11px;display:flex;flex-direction:column;gap:4px">
      <div>🔀 Switches: <b>${switches}</b></div>
      <div>📡 Routers: <b>${routers}</b></div>
      <div>💻 End devices: <b>${pcs}</b></div>
      <div>🔗 Trunks: <b>${trunks}</b></div>
      <div>🏷️ VLANs asignadas: <b>${vlansAssigned}/3</b></div>
      <div>⚙️ Sub-interfaces: <b>${subifCount}/3</b></div>
    </div>`;
}

function renderCheckList() {
  const items = [
    { label:'Router en canvas',      ok: state.nodes.some(n=>n.type==='router') },
    { label:'Switch en canvas',      ok: state.nodes.some(n=>n.type==='switch') },
    { label:'≥ 3 PCs conectados',    ok: state.nodes.filter(n=>['pc','server','laptop'].includes(n.type)).length >= 3 },
    { label:'Enlace Trunk al router',ok: hasTrunkToRouter() },
    { label:'3 VLANs asignadas',     ok: [...new Set(state.nodes.filter(n=>n.vlan).map(n=>n.vlan))].length >= 3 },
    { label:'3 Sub-interfaces config',ok: Object.values(state.configuredSubifs).filter(s=>s.encap&&s.ip&&s.active).length >= 3 },
    { label:'Ping inter-VLAN OK',    ok: state.pingDone },
  ];
  document.getElementById('checkList').innerHTML =
    items.map(i=>`<div class="check-item ${i.ok?'ok':'err'}">${i.label}</div>`).join('');
}

function hasTrunkToRouter() {
  const routerIds = state.nodes.filter(n=>n.type==='router').map(n=>n.id);
  return state.links.some(l => l.trunk && (routerIds.includes(l.from)||routerIds.includes(l.to)));
}

// ── STEP NAVIGATION ────────────────────────────────────────
function goStep(n) {
  state.step = n;
  const p = Math.round((n/5)*100);
  document.getElementById('progressFill').style.width = p + '%';
  document.getElementById('stepTitle').textContent = STEPS[n].title;
  document.getElementById('stepDesc').textContent   = STEPS[n].desc;
  for (let i=1; i<=5; i++) {
    const btn = document.getElementById('sBtn'+i);
    btn.classList.remove('active','done');
    if (i===n) btn.classList.add('active');
    else if (state.completedSteps.includes(i)) btn.classList.add('done');
  }
  // Show CLI button from step 4
  const cliBtn = document.getElementById('cliBtn');
  if (n >= 4) cliBtn.classList.add('visible','pulse');
  else cliBtn.classList.remove('visible','pulse');
}

function validateStep() {
  const n = state.step;
  const routers  = state.nodes.filter(n=>n.type==='router');
  const switches = state.nodes.filter(n=>n.type==='switch');
  const pcs      = state.nodes.filter(n=>['pc','server','laptop'].includes(n.type));
  const vlansAssigned = [...new Set(state.nodes.filter(n=>n.vlan).map(n=>n.vlan))];
  const subifs   = Object.values(state.configuredSubifs).filter(s=>s.encap&&s.ip&&s.active);

  if (n===1) {
    if (!routers.length) { showToast('Arrastra al menos 1 Router al canvas','err'); return; }
    if (!switches.length){ showToast('Arrastra al menos 1 Switch al canvas','err'); return; }
    if (pcs.length < 3)  { showToast('Necesitas al menos 3 PCs/dispositivos finales','err'); return; }
    completeStep(1);
    goStep(2);
  } else if (n===2) {
    const allConnected = pcs.every(pc => state.links.some(l=>l.from===pc.id||l.to===pc.id));
    if (!allConnected) { showToast('Conecta todos los PCs al switch','err'); return; }
    if (!hasTrunkToRouter()) { showToast('Crea un enlace Trunk 802.1Q entre el Switch y el Router','err'); return; }
    completeStep(2);
    goStep(3);
  } else if (n===3) {
    if (vlansAssigned.length < 3) { showToast('Asigna las 3 VLANs (10, 20, 30) a los dispositivos finales','err'); return; }
    completeStep(3);
    goStep(4);
  } else if (n===4) {
    if (subifs.length < 3) { showToast('Configura las 3 sub-interfaces del Router en el CLI (fa0/0.10, .20, .30)','err'); return; }
    completeStep(4);
    goStep(5);
  } else if (n===5) {
    if (!state.pingDone) { showToast('Ejecuta el Ping Test y verifica que el routing funciona','err'); return; }
    completeStep(5);
    showCompletion();
  }
}

function completeStep(n) {
  if (!state.completedSteps.includes(n)) state.completedSteps.push(n);
  showToast(`Paso ${n} completado ✓`, 'ok');
}

function clearCanvas() {
  if (!confirm('¿Limpiar el canvas?')) return;
  state.nodes = []; state.links = [];
  state.connecting = null; removeTempLine();
  render();
}

// ── CLI ROUTER ─────────────────────────────────────────────
function cliPrompt() {
  const m = state.cliMode;
  if (m==='user')       return 'Router>';
  if (m==='priv')       return 'Router#';
  if (m==='conf')       return 'Router(config)#';
  if (m==='conf-subif') return `Router(config-subif)#`;
  return 'Router>';
}

function cliPrint(text, cls='') {
  const out = document.getElementById('cliOutput');
  const line = document.createElement('div');
  if (cls) line.style.color = ({ok:'#10b981',err:'#ef4444',warn:'#f59e0b',info:'#3b82f6',muted:'#64748b'})[cls]||'inherit';
  line.textContent = text;
  out.appendChild(line);
  out.scrollTop = out.scrollHeight;
}

function toggleCLI() {
  const ov = document.getElementById('cliOverlay');
  const open = ov.classList.toggle('open');
  if (open) {
    if (!document.getElementById('cliOutput').children.length) {
      cliPrint('Cisco IOS Software, Version 15.1 — Router-on-a-Stick Lab');
      cliPrint('Clínica San Rafael · Sub-interfaces fa0/0.10 / .20 / .30');
      cliPrint('');
      cliPrint('Usa "enable" para entrar al modo privilegiado.', 'muted');
    }
    document.getElementById('cliInput').focus();
  }
}
function closeCLI() { document.getElementById('cliOverlay').classList.remove('open'); }

function onCLI(e) {
  if (e.key === 'ArrowUp') {
    if (state.cliHistIdx < state.cliHistory.length-1) {
      state.cliHistIdx++;
      e.target.value = state.cliHistory[state.cliHistory.length-1-state.cliHistIdx] || '';
    }
    return;
  }
  if (e.key === 'ArrowDown') {
    if (state.cliHistIdx > 0) { state.cliHistIdx--; e.target.value = state.cliHistory[state.cliHistory.length-1-state.cliHistIdx]||''; }
    else { state.cliHistIdx=-1; e.target.value=''; }
    return;
  }
  if (e.key !== 'Enter') return;
  const raw = e.target.value.trim();
  if (!raw) return;
  state.cliHistory.push(raw); state.cliHistIdx=-1;
  const prompt = cliPrompt();
  cliPrint(`${prompt} ${raw}`, 'muted');
  e.target.value = '';
  processCmd(raw.toLowerCase().replace(/\s+/g,' '));
  document.getElementById('cliPromptLbl').textContent = cliPrompt();
}

function processCmd(cmd) {
  const m = state.cliMode;

  // universal
  if (cmd==='exit'||cmd==='end') {
    if (m==='conf-subif') { state.cliMode='conf'; state.cliSubif=null; cliPrint(''); return; }
    if (m==='conf')       { state.cliMode='priv'; cliPrint(''); return; }
    if (m==='priv')       { state.cliMode='user'; cliPrint(''); return; }
  }

  if (m==='user') {
    if (cmd==='enable'||cmd==='en') { state.cliMode='priv'; cliPrint(''); return; }
    cliPrint('% Unknown command', 'err'); return;
  }

  if (m==='priv') {
    if (cmd==='configure terminal'||cmd==='conf t'||cmd==='conf terminal') {
      state.cliMode='conf'; cliPrint('Enter configuration commands, one per line. End with Ctrl+Z.'); return;
    }
    // show ip interface brief
    if (cmd==='show ip interface brief'||cmd==='sh ip int br'||cmd==='sh ip int brief') {
      cliPrint('Interface          IP-Address       OK? Method Status');
      cliPrint('FastEthernet0/0    unassigned       YES unset  up    up', 'muted');
      const entries = Object.entries(state.configuredSubifs);
      if (!entries.length) { cliPrint('(no sub-interfaces configured yet)', 'muted'); return; }
      entries.forEach(([id,s]) => {
        const ip  = s.ip || 'unassigned';
        const ok  = s.ip ? 'YES' : 'NO ';
        const st1 = s.active ? 'up  ' : 'administratively down';
        const st2 = s.active ? 'up'   : 'down';
        const col = s.active ? 'ok' : 'warn';
        cliPrint(`${id.padEnd(18)} ${ip.padEnd(16)} ${ok}  manual ${st1} ${st2}`, col);
      });
      return;
    }
    if (cmd==='show ip route') {
      const subifs = Object.entries(state.configuredSubifs).filter(([,s])=>s.encap&&s.ip&&s.active);
      if (!subifs.length) { cliPrint('No route entries.','warn'); return; }
      cliPrint('Codes: C - connected, S - static');
      subifs.forEach(([id, s]) => {
        cliPrint(`C    ${VLAN_NETS[s.encap]}.0/24 is directly connected, ${id}`, 'ok');
      });
      return;
    }
    if (cmd==='show interfaces trunk') {
      const trunks = state.links.filter(l=>l.trunk);
      if (!trunks.length) { cliPrint('No trunk interfaces.','warn'); return; }
      cliPrint('Port        Mode     Encapsulation  Status');
      cliPrint('Fa0/0       on       802.1q         trunking', 'ok');
      return;
    }
    if (cmd==='show running-config'||cmd==='sh run') {
      cliPrint('hostname Router');
      cliPrint('!');
      Object.entries(state.configuredSubifs).forEach(([id,s]) => {
        cliPrint(`interface ${id}`);
        if (s.encap) cliPrint(` encapsulation dot1Q ${s.encap}`);
        if (s.ip)    cliPrint(` ip address ${s.ip} 255.255.255.0`);
        if (s.active) cliPrint(` no shutdown`);
        cliPrint('!');
      });
      return;
    }
    cliPrint('% Unknown command (priv mode)', 'err'); return;
  }

  if (m==='conf') {
    // do <show-cmd> — ejecutar comando exec desde conf mode (estándar Cisco IOS)
    if (cmd.startsWith('do ')) {
      const saved = state.cliMode;
      state.cliMode = 'priv';
      processCmd(cmd.slice(3));
      state.cliMode = saved;
      return;
    }
    // interface fa0/0.XX
    const ifMatch = cmd.match(/^(int(?:erface)?)\s+(fa\d+\/\d+\.\d+|gi\d+\/\d+\.\d+)$/);
    if (ifMatch) {
      state.cliSubif = ifMatch[2].replace('interface ','');
      if (!state.configuredSubifs[state.cliSubif]) state.configuredSubifs[state.cliSubif] = {};
      state.cliMode = 'conf-subif';
      cliPrint(`Entered sub-interface ${state.cliSubif}`, 'info');
      return;
    }
    cliPrint('% Unknown command. Try: interface fa0/0.10  |  Tip: usa "do show ..." para comandos show', 'err'); return;
  }

  if (m==='conf-subif') {
    // do <show-cmd> desde conf-subif mode
    if (cmd.startsWith('do ')) {
      const saved = state.cliMode;
      state.cliMode = 'priv';
      processCmd(cmd.slice(3));
      state.cliMode = saved;
      return;
    }
    const sub = state.configuredSubifs[state.cliSubif] || {};
    // encapsulation dot1Q <vlan>
    const encMatch = cmd.match(/^enc(?:apsulation)?\s+dot1q\s+(\d+)$/);
    if (encMatch) {
      const vlan = parseInt(encMatch[1]);
      if (![10,20,30].includes(vlan)) { cliPrint(`% VLAN ${vlan} no está definida en este lab (usa 10, 20 ó 30)`, 'err'); return; }
      sub.encap = vlan;
      state.configuredSubifs[state.cliSubif] = sub;
      cliPrint(`Encapsulation dot1Q ${vlan} configurado.`, 'ok');
      updateStatus(); render(); return;
    }
    // ip address X.X.X.X M
    const ipMatch = cmd.match(/^ip\s+addr(?:ess)?\s+([\d.]+)\s+([\d.]+)$/);
    if (ipMatch) {
      sub.ip = ipMatch[1];
      state.configuredSubifs[state.cliSubif] = sub;
      cliPrint(`IP ${ipMatch[1]} ${ipMatch[2]} asignada a ${state.cliSubif}.`, 'ok');
      updateStatus(); render(); return;
    }
    // no shutdown
    if (cmd==='no shutdown'||cmd==='no shut') {
      if (!sub.encap) { cliPrint('Configure encapsulation primero.','err'); return; }
      if (!sub.ip)    { cliPrint('Configure IP address primero.','err'); return; }
      sub.active = true;
      state.configuredSubifs[state.cliSubif] = sub;
      cliPrint(`%LINEPROTO-5-UPDOWN: Line protocol on Interface ${state.cliSubif}, changed state to up`, 'ok');
      updateStatus(); render(); return;
    }
    cliPrint('% Unknown sub-if command. Try: encapsulation dot1Q 10 | ip address 10.10.10.1 255.255.255.0 | no shutdown | do show ip interface brief', 'err');
  }
}

// ── PING TEST ──────────────────────────────────────────────
function openPingModal() { document.getElementById('pingModal').classList.add('show'); buildPingBody(); }
function closePing()     { document.getElementById('pingModal').classList.remove('show'); }

function buildPingBody() {
  const endNodes = state.nodes.filter(n=>['pc','server','laptop'].includes(n.type)&&n.vlan);
  if (endNodes.length < 2) {
    document.getElementById('pingBody').innerHTML = '<p style="color:var(--muted);font-size:12px">Necesitas al menos 2 dispositivos con VLAN asignada.</p>';
    return;
  }
  let html = '<div style="font-size:12px;margin-bottom:8px">Dispositivos con VLAN:</div><div style="display:flex;flex-direction:column;gap:4px">';
  endNodes.forEach(n => {
    const idx = endNodes.indexOf(n)+1;
    const net = VLAN_NETS[n.vlan];
    html += `<div style="font-size:11px;font-family:monospace;color:${VLAN_COLORS[n.vlan]}">${n.label} — ${net}.${idx*10} (VLAN ${n.vlan})</div>`;
  });
  html += '</div>';
  document.getElementById('pingBody').innerHTML = html;
}

function runPingTest() {
  const endNodes = state.nodes.filter(n=>['pc','server','laptop'].includes(n.type)&&n.vlan);
  const subifs   = Object.values(state.configuredSubifs).filter(s=>s.encap&&s.ip&&s.active);
  const out      = document.getElementById('pingOutput');
  out.innerHTML  = '';

  const addLine = (t,cls) => {
    const d = document.createElement('div'); d.className = 'ping-'+cls; d.textContent = t; out.appendChild(d);
  };

  if (subifs.length < 3) {
    addLine('✗ Router no tiene las 3 sub-interfaces configuradas. Configura fa0/0.10, .20, .30 en el CLI.','err');
    return;
  }
  if (!hasTrunkToRouter()) {
    addLine('✗ No hay enlace Trunk entre el Switch y el Router.','err');
    return;
  }
  if (endNodes.length < 2) {
    addLine('✗ Necesitas al menos 2 dispositivos con VLANs asignadas.','err');
    return;
  }

  addLine('Iniciando test de routing inter-VLAN...','info');
  addLine('','info');

  let ok = 0, total = 0;
  for (let i=0; i<endNodes.length; i++) {
    for (let j=i+1; j<endNodes.length; j++) {
      const a = endNodes[i], b = endNodes[j];
      total++;
      const aNet = VLAN_NETS[a.vlan], bNet = VLAN_NETS[b.vlan];
      const aIdx = (i+1)*10, bIdx = (j+1)*10;
      const sameVlan = a.vlan === b.vlan;
      const aHasSubif = subifs.find(s=>s.encap===a.vlan);
      const bHasSubif = subifs.find(s=>s.encap===b.vlan);
      if (aHasSubif && bHasSubif) {
        addLine(`ping ${aNet}.${aIdx} → ${bNet}.${bIdx} ... EXITO (via Router sub-if)`, 'ok');
        ok++;
      } else {
        addLine(`ping ${aNet}.${aIdx} → ${bNet}.${bIdx} ... FALLO (sub-interface no configurada)`, 'err');
      }
    }
  }
  addLine('','info');
  if (ok === total && ok > 0) {
    addLine(`✓ ${ok}/${total} rutas OK — Routing inter-VLAN funcionando correctamente.`, 'ok');
    state.pingDone = true;
    render();
  } else {
    addLine(`${ok}/${total} rutas OK — Verifica las sub-interfaces en el CLI.`, 'err');
  }
}

// ── COMPLETION ─────────────────────────────────────────────
function showCompletion() {
  const subifCount = Object.values(state.configuredSubifs).filter(s=>s.encap&&s.ip&&s.active).length;
  document.getElementById('cst-dev').textContent = state.nodes.length;
  document.getElementById('cst-sub').textContent = subifCount;
  const ov = document.getElementById('compOverlay');
  const card = document.getElementById('compCard');
  ov.classList.add('show');
  launchConfetti(card);
}

function launchConfetti(container) {
  const colors = ['#f59e0b','#10b981','#3b82f6','#a78bfa','#f472b6'];
  for (let i=0; i<50; i++) {
    const p = document.createElement('div');
    p.className = 'confetti-p';
    p.style.cssText = `
      left:${Math.random()*100}%;top:${Math.random()*30-10}%;
      width:${6+Math.random()*6}px;height:${6+Math.random()*6}px;
      background:${colors[Math.floor(Math.random()*colors.length)]};
      animation:confettiFall ${1.5+Math.random()*2}s ${Math.random()*.8}s ease-out forwards`;
    container.appendChild(p);
    setTimeout(()=>p.remove(), 4000);
  }
}

// ── TOAST ──────────────────────────────────────────────────
let toastTimer;
function showToast(msg, type='ok') {
  const t = document.getElementById('toast');
  const colors = { ok:'#10b981', err:'#ef4444', warn:'#f59e0b' };
  t.textContent = msg;
  t.style.background = colors[type] || colors.ok;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2800);
}

// ── INIT ───────────────────────────────────────────────────
goStep(1);
render();

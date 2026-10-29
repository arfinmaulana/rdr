'use strict';

// Edit identity and the optional local learning resource here only.
// Empty fields/asset paths stay hidden; no network request is needed.
const MEDIA_CONFIG = {
  team: { name: '', institution: '', members: '', supervisor: '' },
  lkpd: {
    href: './assets/LKPD_dan_Rubrik_Relay.pdf',
    description: 'PDF 5 halaman: LKPD siswa dan lembar jawaban individual (hal. 1–3), serta panduan guru, kunci, dan rubrik (hal. 4–5). Berkas tersedia dalam salinan lokal.',
  },
};

function renderMediaInfo() {
  const team = document.getElementById('media-team');
  team.replaceChildren();
  [['name', 'Tim'], ['institution', 'Institusi'], ['members', 'Anggota'], ['supervisor', 'Pembimbing']].forEach(([key, label]) => {
    const value = MEDIA_CONFIG.team[key].trim();
    if (!value) return;
    const row = document.createElement('div');
    const term = document.createElement('dt'), detail = document.createElement('dd');
    term.textContent = label; detail.textContent = value;
    row.append(term, detail); team.append(row);
  });
  team.hidden = !team.childElementCount;
  const href = MEDIA_CONFIG.lkpd.href.trim();
  const localPDF = /^(\.\/)?assets\/[\w./-]+\.pdf$/i.test(href) && !href.includes('..');
  document.getElementById('lkpd-section').hidden = !localPDF;
  const link = document.getElementById('lkpd-link');
  if (localPDF) link.setAttribute('href', href);
  else link.removeAttribute('href');
  document.getElementById('lkpd-description').textContent = MEDIA_CONFIG.lkpd.description;
}

const state = {
  selectedCable: null,
  firstTerminal: null,
  connections: [],
  switchOn: false,
  relayEnergized: false,
  lampType: 'incandescent',
  lampCount: 1,
  lamps: [],
  activePaths: [],
  activeSegments: [],
  relayUnstable: false,
  shortCircuit: false,
  currentVisualizationOn: false,
};

const board = document.querySelector('.component-board');
const wireLayer = document.querySelector('.wire-layer');
const statusMessage = document.getElementById('status-message');
const cableButtons = document.querySelectorAll('[data-cable]');
const terminalElements = new Map(
  Array.from(board.querySelectorAll('.terminal'), terminal => [terminal.id, terminal])
);
let nextWireId = 1;
let redrawFrame = null;

// Visual docking only: never used by the electrical graph.
const dockingDirections = {
  'battery-positive': 'up', 'battery-negative': 'up',
  'relay-30': 'left', 'relay-85': 'left', 'relay-87': 'right', 'relay-86': 'right',
  'fuse-1-a': 'left', 'fuse-1-b': 'right', 'fuse-2-a': 'left', 'fuse-2-b': 'right',
  'switch-a': 'left', 'switch-b': 'left',
};
function dockingDirection(id) { return id.startsWith('lamp-') ? 'down' : dockingDirections[id]; }

function setStatus(message) {
  const reverseFeedback = reverseLEDFeedback();
  statusMessage.textContent = state.shortCircuit ? 'Hubungan singkat terdeteksi. Status relay tidak dapat dipastikan; lintasan arus tidak ditampilkan.' :
    state.relayUnstable ? 'Konfigurasi relay tidak stabil. Periksa jalur kumparan dan kontak.' :
      [message, reverseFeedback].filter(Boolean).join(' ');
  document.querySelector('.footer').classList.toggle('has-warning', state.shortCircuit || state.relayUnstable);
}

// Keep the existing conservative LED warning as lightweight status feedback;
// no manual diagnosis panel or grading system is needed.
function reverseLEDFeedback() {
  if (state.lampType !== 'led' || state.shortCircuit || state.relayUnstable) return '';
  const edges = buildElectricalGraph(state.relayEnergized);
  const reversed = state.lamps.filter(lamp => !lamp.on && analyzeClosedPaths(edges.map(edge =>
    edge.id === lamp.id ? { ...edge, directed: false } : edge)).paths.some(path =>
    path.segments.some(segment => segment.id === lamp.id && segment.from === `${lamp.id}-b`)));
  return reversed.length ? `Polaritas LED ${reversed.map(lamp => lamp.id.split('-')[1]).join(', ')} terbalik.` : '';
}

// Block-cut forest identifies every conductor edge on a simple route between
// two terminals, without enumerating exponentially many paths in a dense net.
// Dangling branches/cycles attached at just one articulation are excluded.
function conductorCoverage(adjacency) {
  const discovery = new Map(), low = new Map(), stack = [], blocks = [];
  let clock = 0;
  function visit(node, parentEdge) {
    discovery.set(node, ++clock); low.set(node, clock);
    for (const edge of adjacency.get(node)) {
      if (edge.id === parentEdge) continue;
      if (!discovery.has(edge.to)) {
        stack.push(edge); visit(edge.to, edge.id);
        low.set(node, Math.min(low.get(node), low.get(edge.to)));
        if (low.get(edge.to) >= discovery.get(node)) {
          const block = []; let popped;
          do { popped = stack.pop(); block.push(popped); } while (popped.id !== edge.id);
          blocks.push(block);
        }
      } else if (discovery.get(edge.to) < discovery.get(node)) {
        stack.push(edge); low.set(node, Math.min(low.get(node), discovery.get(edge.to)));
      }
    }
  }
  for (const node of adjacency.keys()) if (!discovery.has(node)) visit(node, null);
  const tree = new Map(Array.from(adjacency.keys(), node => [node, []]));
  blocks.forEach((block, i) => {
    const id = `block:${i}`, nodes = new Set(block.flatMap(edge => [edge.from, edge.to]));
    tree.set(id, Array.from(nodes)); nodes.forEach(node => tree.get(node).push(id));
  });
  return (from, to) => {
    const queue = [from], previous = new Map([[from, null]]);
    for (let i = 0; i < queue.length && !previous.has(to); i++) {
      for (const next of tree.get(queue[i])) if (!previous.has(next)) { previous.set(next, queue[i]); queue.push(next); }
    }
    const ids = new Set();
    for (let node = to; node !== from && previous.has(node); node = previous.get(node)) {
      if (node.startsWith('block:')) blocks[Number(node.slice(6))].forEach(edge => ids.add(edge.id));
    }
    return Array.from(ids);
  };
}

// Every edge retains identity and type for future path overlays.
function buildElectricalGraph(relayClosed) {
  const edges = state.connections.map(c => ({ id: c.id, type: 'wire', from: c.from, to: c.to, load: false, directed: false }));
  const add = (id, type, from, to, load = false, directed = false) => edges.push({ id, type, from, to, load, directed });
  add('fuse-1', 'fuse', 'fuse-1-a', 'fuse-1-b');
  add('fuse-2', 'fuse', 'fuse-2-a', 'fuse-2-b');
  if (state.switchOn) add('switch', 'switch', 'switch-a', 'switch-b');
  if (relayClosed) add('relay-contact', 'relay-contact', 'relay-30', 'relay-87');
  add('relay-coil', 'relay-coil', 'relay-85', 'relay-86', true);
  for (let n = 1; n <= state.lampCount; n++) {
    add(`lamp-${n}`, state.lampType === 'led' ? 'lamp-led' : 'lamp-incandescent', `lamp-${n}-a`, `lamp-${n}-b`, true, state.lampType === 'led');
  }
  return edges;
}

function analyzeClosedPaths(edges) {
  const conductors = new Map(Array.from(terminalElements.keys(), id => [id, []]));
  edges.filter(e => !e.load).forEach(edge => {
    conductors.get(edge.from).push({ ...edge });
    conductors.get(edge.to).push({ ...edge, from: edge.to, to: edge.from });
  });
  // Collapse ideal conductor nets first. Enumerating only load paths is bounded
  // by at most four lamps plus one coil, even with dense or cyclic wiring.
  const netOf = new Map();
  for (const terminal of conductors.keys()) {
    if (netOf.has(terminal)) continue;
    const pending = [terminal]; netOf.set(terminal, terminal);
    while (pending.length) {
      for (const edge of conductors.get(pending.pop())) {
        if (!netOf.has(edge.to)) { netOf.set(edge.to, terminal); pending.push(edge.to); }
      }
    }
  }
  const source = netOf.get('battery-positive'), target = netOf.get('battery-negative');
  if (source === target) return { short: true, paths: [], activeLoads: new Set(), activeSegments: [] };
  const coveringEdges = conductorCoverage(conductors), covered = new Set();
  const adjacency = new Map(Array.from(new Set(netOf.values()), id => [id, []]));
  edges.filter(e => e.load).forEach(edge => {
    const a = netOf.get(edge.from), b = netOf.get(edge.to);
    if (a === b) return; // A shunted load has no potential difference.
    adjacency.get(a).push({ edge, next: b });
    if (!edge.directed) adjacency.get(b).push({ edge: { ...edge, from: edge.to, to: edge.from }, next: a });
  });
  // A representative conductor route for each part of the closed path.
  // This is connectivity data, not calculated current magnitude/distribution.
  function conductorRoute(from, to) {
    const queue = [from], previous = new Map([[from, null]]);
    for (let i = 0; i < queue.length && !previous.has(to); i++) {
      for (const edge of conductors.get(queue[i])) {
        if (!previous.has(edge.to)) { previous.set(edge.to, edge); queue.push(edge.to); }
      }
    }
    const route = [];
    for (let node = to; node !== from;) {
      const edge = previous.get(node); route.push(edge); node = edge.from;
    }
    return route.reverse();
  }
  const paths = [], activeLoads = new Set();
  function visit(net, visited, loads) {
    if (net === target) {
      const segments = [], conductorSections = []; let terminal = 'battery-positive';
      const appendConductors = (from, to) => {
        segments.push(...conductorRoute(from, to));
        const edgeIds = coveringEdges(from, to);
        edgeIds.forEach(id => covered.add(id));
        if (edgeIds.length) conductorSections.push({ from, to, edgeIds });
      };
      loads.forEach(edge => {
        appendConductors(terminal, edge.from); segments.push(edge); covered.add(edge.id);
        activeLoads.add(edge.id); terminal = edge.to;
      });
      appendConductors(terminal, 'battery-negative');
      paths.push({ id: `path-${paths.length + 1}`, type: loads.some(e => e.type === 'relay-coil') ? 'control' : 'load',
        segments: segments.map(({ id, type, from, to }) => ({ id, type, from, to })), conductorSections });
      return;
    }
    for (const { edge, next } of adjacency.get(net)) {
      if (!visited.has(next)) {
        visited.add(next); visit(next, visited, [...loads, edge]); visited.delete(next);
      }
    }
  }
  visit(source, new Set([source]), []);
  return { short: false, paths, activeLoads, netOf,
    activeSegments: edges.filter(edge => covered.has(edge.id)).map(({ id, type, from, to, directed }) => ({ id, type, from, to, directed })) };
}

function evaluateCircuit() {
  // Start at the existing contact state (supports self-hold), then seek a
  // stable result. A two-state cycle is diagnosed, never animated or looped.
  let contact = state.relayEnergized, result;
  const seen = new Set(); state.relayUnstable = false;
  for (let pass = 0; pass < 3; pass++) {
    result = analyzeClosedPaths(buildElectricalGraph(contact));
    if (result.short) break;
    const next = result.activeLoads.has('relay-coil');
    if (next === contact) break;
    seen.add(contact);
    if (seen.has(next)) {
      state.relayUnstable = true; contact = false;
      result = analyzeClosedPaths(buildElectricalGraph(false)); break;
    }
    contact = next;
  }
  state.relayEnergized = contact;
  state.shortCircuit = result.short;
  const suppressed = result.short || state.relayUnstable;
  state.activePaths = suppressed ? [] : result.paths;
  state.activeSegments = suppressed ? [] : result.activeSegments;
  state.lamps = Array.from({ length: state.lampCount }, (_, i) => ({ id: `lamp-${i + 1}`, on: !suppressed && result.activeLoads.has(`lamp-${i + 1}`) }));
  updateLampPower(result);
}

function updateLampPower(result) {
  // Only independent equal-R strings between the ideal supply rails qualify.
  // A branch at an intermediate net needs a resistor-network solver instead.
  const loads = buildElectricalGraph(state.relayEnergized).filter(edge => edge.load);
  const degree = new Map();
  if (result.netOf) loads.filter(edge => result.activeLoads.has(edge.id)).forEach(edge => {
    [edge.from, edge.to].forEach(terminal => {
      const net = result.netOf.get(terminal);
      degree.set(net, (degree.get(net) || 0) + 1);
    });
  });
  state.lamps.forEach(lamp => {
    lamp.relativePower = lamp.on ? null : 0;
    lamp.visualIntensity = lamp.on ? 1 : 0;
    lamp.brightnessModel = lamp.on ? 'led-nominal' : 'off';
    if (!lamp.on || state.lampType !== 'incandescent') return;
    const strings = state.activePaths.filter(path => path.segments.some(edge => edge.id === lamp.id))
      .map(path => path.segments.filter(edge => edge.type.startsWith('lamp-') || edge.type === 'relay-coil'));
    const signatures = new Set(strings.map(string => string.map(edge => edge.id).sort().join(',')));
    const simple = signatures.size === 1 && strings.every(string =>
      string.every(edge => edge.type === 'lamp-incandescent') &&
      string.slice(0, -1).every(edge => degree.get(result.netOf.get(edge.to)) === 2));
    lamp.brightnessModel = simple ? 'equal-resistance-series' : 'unsupported-mixed-nominal';
    if (simple) {
      lamp.relativePower = 1 / strings[0].length ** 2;
      // Display mapping only; electrical power remains the unmodified 1/n².
      lamp.visualIntensity = lamp.relativePower ** 0.4;
    }
  });
}

function refreshTerminals() {
  terminalElements.clear();
  board.querySelectorAll('.terminal').forEach(terminal => {
    terminalElements.set(terminal.id, terminal);
    terminal.setAttribute('role', 'button'); terminal.setAttribute('tabindex', '0');
  });
  if (!terminalElements.has(state.firstTerminal)) state.firstTerminal = null;
  updateSelection();
}

function renderLampBank() {
  const led = state.lampType === 'led';
  document.getElementById('lamp-bank').innerHTML = Array.from({ length: state.lampCount }, (_, i) => {
    const n = i + 1, x = state.lampCount === 1 ? 640 : 140 + i * 1000 / (state.lampCount - 1);
    const name = `Lampu ${led ? 'LED' : 'Pijar'} ${n}`;
    return `<g id="lamp-${n}" class="component" transform="translate(${x} 35)" role="group" aria-label="${name}">
      <path class="lamp-light" d="M-19 72C-19 57-34 55-34 34a34 34 0 0 1 68 0c0 21-15 23-15 38Z" />
      <path d="M-19 72C-19 57-34 55-34 34a34 34 0 0 1 68 0c0 21-15 23-15 38M-21 72h42v13h-42zM-18 85v10q0 9 10 9H8q10 0 10-9V85M-8 72-13 38q-1-8 5-5l8 7 8-7q6-3 5 5L8 72M-16 104v16h-64v8M16 104v16h64v8" />
      ${['a', 'b'].map((side, j) => `<circle id="lamp-${n}-${side}" class="terminal" data-polarity="${led ? (j ? 'negative' : 'positive') : 'none'}" cx="${j ? 80 : -80}" cy="128" r="9" aria-label="${name} terminal ${led ? (j ? 'negatif' : 'positif') : side.toUpperCase()}"></circle>
      <circle class="terminal-hit-area" data-terminal-id="lamp-${n}-${side}" cx="${j ? 80 : -80}" cy="128" r="1" aria-hidden="true" />
      <text class="terminal-label" x="${j ? 80 : -80}" y="106">${led ? (j ? '−' : '+') : side.toUpperCase()}</text>`).join('')}
      <text class="component-label" x="0" y="164">${name}</text><text class="detail-label" x="0" y="187">12 V · ${led ? 'berpolaritas' : 'non-polar'}</text></g>`;
  }).join('');
  refreshTerminals();
}

function updateRelayStatus() {
  const abnormal = state.shortCircuit || state.relayUnstable;
  const coil = state.shortCircuit ? 'tidak dapat dipastikan (hubungan singkat)' :
    state.relayUnstable ? 'tidak stabil' : state.relayEnergized ? 'aktif' : 'tidak aktif';
  const contact = state.shortCircuit ? 'tidak dapat dipastikan' :
    state.relayUnstable ? 'tidak stabil' : state.relayEnergized ? 'tertutup' : 'terbuka';
  document.getElementById('coil-status').textContent = `Kumparan: ${coil}`;
  document.getElementById('contact-status').textContent = `Kontak: ${contact}`;
  document.getElementById('relay-status').dataset.state = abnormal ? 'warning' : state.relayEnergized ? 'on' : 'off';
  const relay = document.getElementById('relay');
  relay.dataset.state = abnormal ? 'warning' : state.relayEnergized ? 'on' : 'off';
  relay.classList.toggle('is-energized', !abnormal && state.relayEnergized);
  relay.setAttribute('aria-label', `Relay. Kumparan: ${coil}. Kontak: ${contact}.`);
}

function updateCurrentLegend() {
  const legend = document.getElementById('current-legend');
  legend.hidden = !state.currentVisualizationOn;
  const note = document.getElementById('legend-note');
  if (state.shortCircuit || state.relayUnstable) {
    note.textContent = 'Lintasan tidak ditampilkan: ' + (state.shortCircuit ? 'hubungan singkat.' : 'relay tidak stabil.');
  } else if (!state.activePaths.length) {
    note.textContent = 'Belum ada lintasan aktif yang dapat ditampilkan. Visualisasi memakai lintasan representatif.';
  } else {
    const mixed = state.activePaths.some(path => path.type === 'control' && path.segments.some(edge => edge.type.startsWith('lamp-')));
    note.textContent = (mixed ? 'Lintasan campuran: biru juga dapat melewati lampu. ' : '') +
      'Lintasan representatif; segmen bersama memakai warna lintasan pertama, bukan pembagian arus fisik.';
  }
}

function updateComponentVisuals(message) {
  updateSwitchVisual();
  updateRelayStatus();
  state.lamps.forEach(({ id, on, relativePower, visualIntensity, brightnessModel }, i) => {
    const lamp = document.getElementById(id);
    lamp.classList.toggle('is-on', on);
    lamp.style.setProperty('--visual-intensity', visualIntensity);
    lamp.dataset.relativePower = relativePower === null ? 'unsupported' : String(relativePower);
    lamp.dataset.brightnessModel = brightnessModel;
    lamp.setAttribute('aria-label', `Lampu ${state.lampType === 'led' ? 'LED' : 'Pijar'} ${i + 1} 12 V, ${on ? 'menyala' : 'padam'}`);
  });
  document.getElementById('lamp-type').value = state.lampType;
  document.getElementById('lamp-count').textContent = `${state.lampCount} lampu`;
  document.getElementById('add-lamp').disabled = state.lampCount === 4;
  document.getElementById('remove-lamp').disabled = state.lampCount === 1;
  document.getElementById('undo-button').disabled = state.connections.length === 0;
  document.getElementById('current-toggle').setAttribute('aria-pressed', String(state.currentVisualizationOn));
  document.getElementById('brightness-note').textContent = state.lamps.some(lamp => lamp.brightnessModel === 'unsupported-mixed-nominal')
    ? 'Rangkaian campuran: terang nominal; daya detail belum dihitung.'
    : state.lampType === 'led' ? 'LED berpolaritas: A positif, B negatif. Amati hubungan kumparan, kontak, dan lampu.' : 'Amati hubungan kumparan, kontak, dan lampu.';
  renderCurrentVisualization();
  setStatus(message);
}

function updateSelection() {
  cableButtons.forEach(button => {
    button.setAttribute('aria-pressed', String(button.dataset.cable === state.selectedCable));
  });
  terminalElements.forEach(terminal => {
    const selected = terminal.id === state.firstTerminal;
    terminal.classList.toggle('is-selected', selected);
    terminal.setAttribute('aria-pressed', String(selected));
  });
  renderSockets();
}

function selectCable(color) {
  state.selectedCable = color;
  // Changing tools starts a fresh pair so the intended wire color is explicit.
  state.firstTerminal = null;
  updateSelection();
  setStatus(`Kabel ${color === 'red' ? 'merah' : 'hitam'} aktif. Pilih terminal pertama.`);
}

function selectTerminal(id) {
  if (!terminalElements.has(id)) return;
  if (!state.selectedCable) {
    setStatus('Pilih kabel merah atau hitam terlebih dahulu.');
    return;
  }
  if (state.firstTerminal === id) {
    state.firstTerminal = null;
    updateSelection();
    setStatus('Pilihan dibatalkan. Pilih terminal pertama.');
    return;
  }
  if (!state.firstTerminal) {
    state.firstTerminal = id;
    updateSelection();
    setStatus(`${terminalElements.get(id).getAttribute('aria-label')} dipilih. Pilih terminal tujuan.`);
    return;
  }

  const from = state.firstTerminal;
  const duplicate = state.connections.some(connection =>
    (connection.from === from && connection.to === id) ||
    (connection.from === id && connection.to === from)
  );
  state.firstTerminal = null;
  updateSelection();
  if (duplicate) {
    setStatus('Kedua terminal sudah terhubung. Pilih pasangan terminal lain.');
    return;
  }

  state.connections.push({
    id: `wire-${nextWireId++}`,
    from,
    to: id,
    color: state.selectedCable
  });
  evaluateCircuit();
  updateComponentVisuals('Kabel berhasil dipasang. Pilih terminal pertama untuk kabel berikutnya.');
  redrawWires();
}

// Always read the visible circle, never the larger transparent touch target.
// Both rectangles use viewport coordinates; subtracting the overlay origin
// gives SVG coordinates in CSS pixels, including after scrolling or resizing.
function terminalCenter(id, layerRect) {
  const rect = terminalElements.get(id).getBoundingClientRect();
  return {
    x: rect.left + rect.width / 2 - layerRect.left,
    y: rect.top + rect.height / 2 - layerRect.top
  };
}

// Routing is geometric only: there is no notion of correct electrical wiring.
// Bounds include each component's labels, so the main routes avoid those too.
function routingObstacles(layerRect) {
  return Array.from(board.querySelectorAll('.component'), element => {
    const rect = element.getBoundingClientRect();
    return {
      element,
      left: rect.left - layerRect.left - 14,
      right: rect.right - layerRect.left + 14,
      top: rect.top - layerRect.top - 14,
      bottom: rect.bottom - layerRect.top + 14
    };
  });
}

function terminalPort(id, center, obstacles, branch = 0) {
  const component = terminalElements.get(id).closest('.component');
  const box = obstacles.find(obstacle => obstacle.element === component);
  const direction = dockingDirection(id);
  const offset = 8 + branch * LANE_SPACING;
  if (direction === 'up') return { x: center.x, y: Math.min(center.y - 18, box.top - 8) - branch * LANE_SPACING };
  if (direction === 'down') return { x: center.x, y: center.y + 18 };
  return { x: direction === 'left' ? Math.min(center.x - 18, box.left - offset) : Math.max(center.x + 18, box.right + offset), y: center.y };
}

const LANE_SPACING = 6;

// Rebuilt per redraw: adjacent channels separate occupied lanes without
// storing screen coordinates in electrical connection data.
function adjacentLanes(segments, axis) {
  return Array.from(new Set(segments.filter(([a, b]) => axis === 'x' ? a.x === b.x : a.y === b.y)
    .flatMap(([a]) => [a[axis] - LANE_SPACING, a[axis] + LANE_SPACING])));
}

function segmentBlocked(a, b, obstacles) {
  return obstacles.some(box => a.y === b.y
    ? a.y > box.top && a.y < box.bottom && Math.max(a.x, b.x) > box.left && Math.min(a.x, b.x) < box.right
    : a.x > box.left && a.x < box.right && Math.max(a.y, b.y) > box.top && Math.min(a.y, b.y) < box.bottom);
}

function congestionCost(a, b, existingSegments) {
  let cost = 0;
  const horizontal = a.y === b.y;
  existingSegments.forEach(([c, d]) => {
    const otherHorizontal = c.y === d.y;
    if (horizontal === otherHorizontal) {
      const gap = Math.abs(horizontal ? a.y - c.y : a.x - c.x);
      const overlap = horizontal
        ? Math.min(Math.max(a.x, b.x), Math.max(c.x, d.x)) - Math.max(Math.min(a.x, b.x), Math.min(c.x, d.x))
        : Math.min(Math.max(a.y, b.y), Math.max(c.y, d.y)) - Math.max(Math.min(a.y, b.y), Math.min(c.y, d.y));
      if (gap < LANE_SPACING - 0.01 && overlap > 2) cost += overlap * 30 + 200;
    } else {
      const h1 = horizontal ? a : c, h2 = horizontal ? b : d;
      const v1 = horizontal ? c : a, v2 = horizontal ? d : b;
      if (v1.x >= Math.min(h1.x, h2.x) && v1.x <= Math.max(h1.x, h2.x) &&
          h1.y >= Math.min(v1.y, v2.y) && h1.y <= Math.max(v1.y, v2.y)) cost += 45;
    }
  });
  return cost;
}

// Bounded corridor candidates, not a grid search. Try direct/L/Z routes, then
// at most two detour lanes from obstacle edges or occupied segment neighbors.
function routeBetweenPorts(start, end, obstacles, existingSegments, bounds, startDirection, endDirection, startAxis = 'h', endAxis = 'h', limits = {}) {
  const lanes = (values, limit) => Array.from(new Set(values.filter(v => v >= 4 && v <= limit - 4))).sort((a, b) => a - b);
  const xs = lanes([start.x, end.x, (start.x + end.x) / 2, 5, bounds.width - 5,
    ...adjacentLanes(existingSegments, 'x'), ...obstacles.flatMap(box => [box.left - 6, box.right + 6])], bounds.width);
  const ys = lanes([start.y, end.y, (start.y + end.y) / 2, 5, bounds.height - 5,
    ...adjacentLanes(existingSegments, 'y'), ...obstacles.flatMap(box => [box.top - 6, box.bottom + 6])], bounds.height);
  let best = null, bestScore = Infinity;
  function consider(raw) {
    const points = raw.filter((p, i) => !i || p.x !== raw[i - 1].x || p.y !== raw[i - 1].y);
    if (points.length < 2) { best = points; bestScore = 0; return; }
    let score = 0, lastDx = 0, lastDy = 0;
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1], b = points[i], dx = Math.sign(b.x - a.x), dy = Math.sign(b.y - a.y);
      if ((dx && dy) || b.x < 4 || b.x > bounds.width - 4 || b.y < (limits.minY ?? 4) || b.y > bounds.height - 4) return;
      if (i === 1 && (startAxis === 'h' ? dx && dx !== startDirection : dy && dy !== startDirection)) return;
      if (i === points.length - 1 && (endAxis === 'h' ? dx && dx !== -endDirection : dy && dy !== -endDirection)) return;
      if (limits.monotonicY && dy && dy !== Math.sign(end.y - start.y)) return;
      if (limits.monotonicX && dx && dx !== Math.sign(end.x - start.x)) return;
      if (segmentBlocked(a, b, obstacles)) return;
      if (i > 1 && dx * lastDx + dy * lastDy < 0) return;
      if (i > 1 && (dx !== lastDx || dy !== lastDy)) score += 35;
      if (dx * (end.x - start.x) < 0 || dy * (end.y - start.y) < 0) score += 300;
      score += Math.abs(a.x - b.x) + Math.abs(a.y - b.y) + congestionCost(a, b, existingSegments);
      lastDx = dx; lastDy = dy;
    }
    if (score < bestScore) { best = simplifyRoute(points); bestScore = score; }
  }
  consider([start, { x: end.x, y: start.y }, end]);
  consider([start, { x: start.x, y: end.y }, end]);
  xs.forEach(x => consider([start, { x, y: start.y }, { x, y: end.y }, end]));
  ys.forEach(y => consider([start, { x: start.x, y }, { x: end.x, y }, end]));
  // More bends are considered only if needed to avoid bodies or long overlap.
  const directLength = Math.abs(end.x - start.x) + Math.abs(end.y - start.y);
  const approach = {
    x: end.x + (endAxis === 'h' ? endDirection * LANE_SPACING : 0),
    y: end.y + (endAxis === 'v' ? endDirection * LANE_SPACING : 0),
  };
  if (bestScore > directLength + 250) for (const x of xs) for (const y of ys) {
    consider([start, { x, y: start.y }, { x, y }, { x: end.x, y }, end]);
    consider([start, { x: start.x, y }, { x, y }, { x, y: end.y }, end]);
    // One adjacent approach lane keeps the final docking direction while
    // separating a return cable from an occupied supply corridor.
    consider([start, { x: start.x, y }, { x, y }, { x, y: approach.y }, approach, end]);
    consider([start, { x, y: start.y }, { x, y }, { x: approach.x, y }, approach, end]);
  }
  return best;
}

function simplifyRoute(points) {
  const result = [];
  points.forEach(point => {
    const last = result[result.length - 1];
    if (last && last.x === point.x && last.y === point.y) return;
    if (result.length > 1) {
      const previous = result[result.length - 2];
      if ((previous.x === last.x && last.x === point.x) ||
          (previous.y === last.y && last.y === point.y)) {
        result.pop();
        if (previous.x === point.x && previous.y === point.y) return;
      }
    }
    result.push(point);
  });
  return result;
}

// Reusable path generator: a future overlay can copy the base path's d exactly.
function roundedRoutePath(points, radius = 12) {
  points = simplifyRoute(points);
  let data = `M ${points[0].x} ${points[0].y}`;
  for (let i = 1; i < points.length - 1; i++) {
    const a = points[i - 1], corner = points[i], b = points[i + 1];
    const incoming = Math.hypot(corner.x - a.x, corner.y - a.y);
    const outgoing = Math.hypot(b.x - corner.x, b.y - corner.y);
    if (!incoming || !outgoing) continue;
    const r = Math.min(radius, incoming / 2, outgoing / 2);
    const before = { x: corner.x + (a.x - corner.x) * r / incoming, y: corner.y + (a.y - corner.y) * r / incoming };
    const after = { x: corner.x + (b.x - corner.x) * r / outgoing, y: corner.y + (b.y - corner.y) * r / outgoing };
    data += ` L ${before.x} ${before.y} Q ${corner.x} ${corner.y} ${after.x} ${after.y}`;
  }
  const end = points[points.length - 1];
  return `${data} L ${end.x} ${end.y}`;
}

function buildWireRoute(start, end, startPort, endPort, obstacles, existingSegments, bounds) {
  const startAxis = start.x === startPort.x ? 'v' : 'h', endAxis = end.x === endPort.x ? 'v' : 'h';
  const startDirection = Math.sign(startAxis === 'v' ? startPort.y - start.y : startPort.x - start.x);
  const endDirection = Math.sign(endAxis === 'v' ? endPort.y - end.y : endPort.x - end.x);
  const route = routeBetweenPorts(startPort, endPort, obstacles, existingSegments, bounds,
    startDirection, endDirection, startAxis, endAxis, { monotonicY: true, monotonicX: true }) ||
    routeBetweenPorts(startPort, endPort, obstacles, existingSegments, bounds, startDirection, endDirection, startAxis, endAxis);
  return simplifyRoute([start, ...(route || [startPort, { x: startPort.x, y: endPort.y }, endPort]), end]);
}

function buildLampWireRoute(start, end, startPort, endPort, fromLamp, toLamp, obstacles, segments, bounds) {
  // Fixed short vertical stub, then an outward horizontal escape clear of the
  // lamp's labels. Main lanes are allocated by endpoints + shared occupancy,
  // never by cable color or a growing global lamp-lane counter.
  const escape = (point, stub, isLamp) => {
    if (!isLamp) return stub;
    const box = obstacles.find(box => box.element.parentElement.id === 'lamp-bank' &&
      point.x >= box.left && point.x <= box.right && point.y >= box.top && point.y <= box.bottom);
    const left = point.x < (box.left + box.right) / 2;
    return { x: left ? box.left - 8 : box.right + 8, y: stub.y };
  };
  const a = escape(start, startPort, fromLamp), b = escape(end, endPort, toLamp);
  const startAxis = a.x === start.x ? 'v' : 'h', endAxis = b.x === end.x ? 'v' : 'h';
  const startDirection = Math.sign(startAxis === 'v' ? a.y - start.y : a.x - start.x);
  const endDirection = Math.sign(endAxis === 'v' ? b.y - end.y : b.x - end.x);
  const minY = Math.min(a.y, b.y);
  // Congestion must never buy an unnecessary vertical reversal. Only relax
  // monotonicity if obstacles prevent a monotonic route (e.g. two lamp banks).
  let route = routeBetweenPorts(a, b, obstacles, segments, bounds,
    startDirection, endDirection, startAxis, endAxis, { minY, monotonicY: true });
  if (!route) route = routeBetweenPorts(a, b, obstacles, segments, bounds,
    startDirection, endDirection, startAxis, endAxis, { minY });
  return simplifyRoute([start, startPort, ...(route || [a, { x: a.x, y: b.y }, b]), endPort, end]);
}

function redrawWires() {
  const rect = wireLayer.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  wireLayer.setAttribute('viewBox', `0 0 ${rect.width} ${rect.height}`);
  document.querySelector('.current-overlay-layer').setAttribute('viewBox', `0 0 ${rect.width} ${rect.height}`);
  document.querySelector('.wire-current-layer').setAttribute('viewBox', `0 0 ${rect.width} ${rect.height}`);
  const obstacles = routingObstacles(rect), existingSegments = [];
  const terminalBranches = new Map();
  const portFor = (id, center) => {
    const branch = terminalBranches.get(id) || 0;
    terminalBranches.set(id, branch + 1);
    return terminalPort(id, center, obstacles, Math.min(branch, 3));
  };
  const groups = document.createDocumentFragment();
  state.connections.forEach(connection => {
    const start = terminalCenter(connection.from, rect), end = terminalCenter(connection.to, rect);
    const fromLamp = /^lamp-\d+-[ab]$/.test(connection.from), toLamp = /^lamp-\d+-[ab]$/.test(connection.to);
    const startPort = fromLamp ? { x: start.x, y: start.y + 18 } : portFor(connection.from, start);
    const endPort = toLamp ? { x: end.x, y: end.y + 18 } : portFor(connection.to, end);
    const points = fromLamp || toLamp
      ? buildLampWireRoute(start, end, startPort, endPort, fromLamp, toLamp, obstacles, existingSegments, rect)
      : buildWireRoute(start, end, startPort, endPort, obstacles, existingSegments, rect);
    for (let i = 1; i < points.length; i++) existingSegments.push([points[i - 1], points[i]]);
    const data = roundedRoutePath(points);
    const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    group.id = `${connection.id}-group`;
    group.setAttribute('class', 'wire-group');
    group.dataset.connectionId = connection.id;
    for (const layer of ['halo', 'base']) {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', data);
      path.setAttribute('class', layer === 'halo' ? 'wire-halo' : `wire wire-base wire-${connection.color}`);
      if (layer === 'base') path.id = connection.id;
      group.appendChild(path);
    }
    groups.appendChild(group);
  });
  wireLayer.replaceChildren(groups);
  renderCurrentVisualization();
  renderSockets();
}

function renderSockets() {
  const layer = document.querySelector('.socket-layer');
  if (!layer) return;
  const rect = wireLayer.getBoundingClientRect();
  layer.setAttribute('viewBox', `0 0 ${rect.width} ${rect.height}`);
  layer.replaceChildren();
  if (!rect.width || !rect.height) return;
  terminalElements.forEach(terminal => {
    const center = terminalCenter(terminal.id, rect), matrix = terminal.getScreenCTM();
    const socket = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    socket.setAttribute('cx', center.x); socket.setAttribute('cy', center.y);
    socket.setAttribute('r', terminal.r.baseVal.value * Math.hypot(matrix.a, matrix.b));
    socket.setAttribute('class', `socket-visual${terminal.classList.contains('is-selected') ? ' is-selected' : ''}`);
    layer.appendChild(socket);
  });
}

// Canonical component geometry uses local SVG coordinates. These hidden paths
// survive redraws; only dynamic lamp replacements require a new local path.
function internalCurrentGeometry(segment) {
  const definitions = {
    'fuse-1': ['fuse-1-a', 'M0 0H50c0-13 15-13 25 0s25 13 25 0H150'],
    'fuse-2': ['fuse-2-a', 'M0 66H50c0-13 15-13 25 0s25 13 25 0H150'],
    switch: ['switch-a', 'M0 20H65Q72 20 72 27V75Q72 82 65 82H0'],
    'relay-contact': ['relay-30', 'M-18 52H283'],
    'relay-coil': ['relay-85', 'M-18 181H85c0-36 24-36 24 0 0-36 24-36 24 0 0-36 24-36 24 0 0-36 23-36 23 0H283'],
  };
  const lamp = segment.type.startsWith('lamp-');
  const definition = lamp ? [`${segment.id}-a`,
    'M-80 128V120H-16V104L-8 72L-13 38q-1-8 5-5l8 7 8-7q6-3 5 5L8 72L16 104V120H80V128'] : definitions[segment.id];
  if (!definition) return null;
  const [from, d] = definition, id = `current-geometry-${segment.id}`;
  let path = document.getElementById(id);
  if (!path) {
    path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.id = id; path.setAttribute('class', 'internal-current-geometry');
    path.setAttribute('d', d); path.setAttribute('aria-hidden', 'true');
    terminalElements.get(from).closest('.component').appendChild(path);
  }
  return { path, from };
}

function internalScreenPath(path, rect) {
  // Flatten only internal curves to CSS-pixel coordinates. Cable d is copied
  // exactly. Uniform screen units keep dash size/speed equal across both SVGs.
  const matrix = path.getScreenCTM(), length = path.getTotalLength();
  const count = Math.max(2, Math.ceil(length / 2));
  return Array.from({ length: count + 1 }, (_, i) => {
    const point = path.getPointAtLength(length * i / count).matrixTransform(matrix);
    return `${i ? 'L' : 'M'}${(point.x - rect.left).toFixed(3)} ${(point.y - rect.top).toFixed(3)}`;
  }).join(' ');
}

function renderCurrentVisualization() {
  updateCurrentLegend();
  const layer = document.querySelector('.current-overlay-layer');
  const wireCurrent = document.querySelector('.wire-current-layer');
  layer.replaceChildren();
  wireCurrent.replaceChildren();
  if (!state.currentVisualizationOn || state.shortCircuit || state.relayUnstable) return;
  const rect = wireLayer.getBoundingClientRect(), rendered = new Set();
  if (!rect.width || !rect.height) return;
  // All paths share a wall-clock animation phase; no per-frame JS work.
  const delay = -(performance.now() % 800) / 1000;
  state.activePaths.forEach(activePath => {
    let travelled = 0;
    activePath.segments.forEach(segment => {
      const wire = segment.type === 'wire';
      const geometry = wire ? { path: document.getElementById(segment.id),
        from: state.connections.find(connection => connection.id === segment.id)?.from }
        : internalCurrentGeometry(segment);
      if (!geometry?.path) return;
      const overlay = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      overlay.setAttribute('d', wire ? geometry.path.getAttribute('d') : internalScreenPath(geometry.path, rect));
      overlay.setAttribute('class', `current-segment current-${activePath.type} ${wire ? 'current-wire' : 'current-internal'}`);
      overlay.dataset.segmentId = segment.id;
      overlay.dataset.from = segment.from; overlay.dataset.to = segment.to;
      overlay.dataset.pathId = activePath.id;
      (wire ? wireCurrent : layer).appendChild(overlay);
      const length = overlay.getTotalLength(), forward = segment.from === geometry.from;
      const phase = forward ? travelled : -(travelled + length) + 6;
      overlay.dataset.direction = forward ? 'forward' : 'reverse';
      overlay.style.setProperty('--phase', phase);
      overlay.style.setProperty('--phase-end', phase + (forward ? -24 : 24));
      overlay.style.animationDelay = `${delay}s`;
      travelled += length;
      // Shared conductor segments are drawn once, using the first valid path.
      // Ideal-network ambiguity is not a computed current distribution.
      if (rendered.has(segment.id)) overlay.remove();
      else rendered.add(segment.id);
    });
  });
}

document.getElementById('current-toggle').addEventListener('click', event => {
  state.currentVisualizationOn = !state.currentVisualizationOn;
  event.currentTarget.setAttribute('aria-pressed', String(state.currentVisualizationOn));
  redrawWires();
  setStatus(`Visualisasi arus ${state.currentVisualizationOn ? 'aktif: + menuju −' : 'nonaktif'}.`);
});

function scheduleRedraw() {
  if (redrawFrame !== null) return;
  redrawFrame = requestAnimationFrame(() => {
    redrawFrame = null;
    redrawWires();
  });
}

cableButtons.forEach(button => {
  button.addEventListener('click', () => selectCable(button.dataset.cable));
});

terminalElements.forEach(terminal => {
  terminal.setAttribute('role', 'button');
  terminal.setAttribute('tabindex', '0');
  terminal.setAttribute('aria-pressed', 'false');
});

// Native click handles mouse and touch taps without firing twice.
board.addEventListener('click', event => {
  const target = event.target.closest('.terminal, .terminal-hit-area');
  if (target) selectTerminal(target.dataset.terminalId || target.id);
});
board.addEventListener('keydown', event => {
  if (event.target.matches('.terminal') && (event.key === 'Enter' || event.key === ' ')) {
    event.preventDefault();
    selectTerminal(event.target.id);
  }
});

document.getElementById('reset-button').addEventListener('click', () => {
  state.connections = [];
  state.firstTerminal = null;
  state.selectedCable = null;
  state.switchOn = false;
  state.relayEnergized = false;
  state.currentVisualizationOn = false;
  state.lampType = 'incandescent';
  state.lampCount = 1;
  renderLampBank();
  nextWireId = 1;
  wireLayer.replaceChildren();
  updateSelection();
  evaluateCircuit();
  updateComponentVisuals('Pilih kabel merah atau hitam.');
});

document.getElementById('undo-button').addEventListener('click', () => {
  if (!state.connections.length) return;
  state.connections.pop();
  state.firstTerminal = null;
  updateSelection();
  evaluateCircuit();
  updateComponentVisuals('Kabel terakhir dibatalkan.');
  redrawWires();
});

const switchControl = document.getElementById('switch-control');
function updateSwitchVisual() {
  const label = state.switchOn ? 'ON' : 'OFF';
  document.getElementById('switch').dataset.state = state.switchOn ? 'on' : 'off';
  document.getElementById('switch').setAttribute('aria-label', `Sakelar ${label}`);
  document.getElementById('switch-status').textContent = `Sakelar ${label}`;
  switchControl.setAttribute('aria-checked', String(state.switchOn));
  switchControl.querySelector('.rocker-face').setAttribute('d', state.switchOn
    ? 'M-23-40h46l6 80h-58z' : 'M-29-40h58l-6 80h-46z');
  switchControl.querySelector('.rocker-depth').setAttribute('d', state.switchOn
    ? 'M-28 29h56l1 11h-58z' : 'M-29-40h58l-.8 11h-56.4z');
  // Label widths may differ, so recompute obstacle bounds and routes.
  scheduleRedraw();
}
function toggleSwitch() {
  state.switchOn = !state.switchOn;
  evaluateCircuit();
  updateComponentVisuals(`Sakelar ${state.switchOn ? 'ON' : 'OFF'}.`);
}
switchControl.addEventListener('click', toggleSwitch);
switchControl.addEventListener('keydown', event => {
  if ((event.key === 'Enter' || event.key === ' ') && !event.repeat) {
    event.preventDefault();
    toggleSwitch();
  }
});

window.addEventListener('resize', scheduleRedraw);
document.querySelector('.board-scroll').addEventListener('scroll', scheduleRedraw, { passive: true });
// Also cover layout changes caused by orientation, toolbar wrapping or fonts.
if (typeof ResizeObserver !== 'undefined') {
  const layoutObserver = new ResizeObserver(scheduleRedraw);
  layoutObserver.observe(document.querySelector('.board-content'));
  layoutObserver.observe(board);
}

document.getElementById('lamp-type').addEventListener('change', event => {
  state.lampType = event.target.value === 'incandescent' ? 'incandescent' : 'led';
  renderLampBank();
  evaluateCircuit();
  updateComponentVisuals(`Jenis beban diubah menjadi ${state.lampType === 'led' ? 'LED' : 'Lampu Pijar'} 12 V.`);
  redrawWires();
});
function changeLampCount(delta) {
  const next = Math.max(1, Math.min(4, state.lampCount + delta));
  if (next === state.lampCount) return;
  state.lampCount = next;
  renderLampBank();
  state.connections = state.connections.filter(c => terminalElements.has(c.from) && terminalElements.has(c.to));
  evaluateCircuit();
  updateComponentVisuals(delta < 0 ? 'Lampu terakhir dan kabel yang terhubung telah dihapus.' : 'Lampu ditambahkan.');
  redrawWires();
}
document.getElementById('add-lamp').addEventListener('click', () => changeLampCount(1));
document.getElementById('remove-lamp').addEventListener('click', () => changeLampCount(-1));

// Native modal supplies focus containment, Escape dismissal, and restoration
// to the opener without changing simulator state or keyboard wiring handlers.
const helpDialog = document.getElementById('help-dialog');
document.getElementById('help-button').addEventListener('click', () => helpDialog.showModal());
document.getElementById('help-close').addEventListener('click', () => helpDialog.close());


renderMediaInfo();
renderLampBank();
evaluateCircuit();
updateComponentVisuals('Pilih kabel merah atau hitam.');


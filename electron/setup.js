// Context Fence — first-run setup screen renderer.
// Real progress: every state change below comes from an actual step
// completion event over IPC. No fake timers, no generic spinner.

const STEPS = [
  { id: 1, title: 'Runtime dependencies', detail: '' },
  { id: 2, title: 'Default policy', detail: '' },
  { id: 3, title: 'Database schema', detail: '' },
  { id: 4, title: 'Agent detection', detail: '' },
];

let current = 0;

function render() {
  const list = document.getElementById('steps');
  list.innerHTML = '';
  STEPS.forEach((s, i) => {
    const li = document.createElement('li');
    li.className = 'step';
    const icon = document.createElement('span');
    icon.className = 'step-icon';
    if (s.done) icon.textContent = '✓';
    else if (s.running) {
      icon.className += ' running';
      icon.textContent = '';
    } else icon.textContent = String(i + 1);
    li.appendChild(icon);
    const body = document.createElement('div');
    body.className = 'step-body';
    const t = document.createElement('div');
    t.className = 'step-title';
    t.textContent = s.done || s.running ? s.title : s.title;
    body.appendChild(t);
    if (s.detail) {
      const d = document.createElement('div');
      d.className = 'step-detail';
      d.textContent = s.detail;
      body.appendChild(d);
    }
    li.appendChild(body);
    list.appendChild(li);
  });
  document.getElementById('bar').style.width = `${Math.round((current / STEPS.length) * 100)}%`;
  document.getElementById('bar').classList.toggle('done', current >= STEPS.length);
}

window.addEventListener('DOMContentLoaded', async () => {
  window.cfSetup.onProgress((p) => {
    STEPS[p.step - 1].done = p.done;
    STEPS[p.step - 1].running = !p.done;
    STEPS[p.step - 1].detail = p.detail;
    current = Math.max(current, p.step);
    render();
  });

  render();
  document.getElementById('bar').classList.add('active');

  const result = await window.cfSetup.run();
  if (result.ok) {
    const status = document.getElementById('status');
    status.textContent = 'Ready — opening Context Fence';
    status.style.color = '#00a699';
    await new Promise((r) => setTimeout(r, 900));
    window.cfSetup.done();
  } else {
    document.getElementById('status').textContent = `Setup failed: ${result.error}`;
    document.getElementById('status').style.color = '#ff5a5f';
    document.getElementById('bar').classList.remove('active');
  }
});

// File sharing: XHR upload with a gel progress bar, drag & drop, live list.
import { $, el, toast, fmtBytes, fmtTime, escapeHtml } from '../util.js';

export function initFiles({ store, api, withToken }) {
  const zone = $('#drop-zone');
  const input = $('#file-input');
  const list = $('#file-list');
  const track = $('#up-track');
  const fill = $('#up-fill');

  // drag & drop is desktop language — speak touch on the phone
  if (store.role === 'phone-client') {
    $('#drop-title').textContent = 'Tap to choose files';
    $('#drop-sub').textContent = 'They appear on the Mac instantly.';
  }

  $('#pick-btn').addEventListener('click', (e) => { e.stopPropagation(); input.click(); });
  zone.addEventListener('click', () => input.click());
  input.addEventListener('change', () => uploadAll([...input.files]));

  ['dragenter', 'dragover'].forEach((evt) =>
    zone.addEventListener(evt, (e) => { e.preventDefault(); zone.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((evt) =>
    zone.addEventListener(evt, (e) => { e.preventDefault(); zone.classList.remove('over'); }));
  zone.addEventListener('drop', (e) => uploadAll([...e.dataTransfer.files]));

  async function uploadAll(files) {
    for (const file of files) await upload(file);
    input.value = '';
  }

  // XHR instead of fetch: upload progress events work everywhere.
  function upload(file) {
    return new Promise((resolve) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/upload');
      xhr.setRequestHeader('X-Aero-Token', store.token);
      xhr.setRequestHeader('X-Filename', encodeURIComponent(file.name));
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      track.classList.add('busy');
      fill.style.width = '0%';
      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable) fill.style.width = `${Math.round((e.loaded / e.total) * 100)}%`;
      });
      xhr.addEventListener('loadend', () => {
        track.classList.remove('busy');
        if (xhr.status === 200) {
          toast(`Sent “${file.name}”`);
        } else {
          toast(`Upload failed (${xhr.status || 'network'})`, true);
        }
        resolve();
      });
      xhr.send(file);
    });
  }

  async function removeFile(id) {
    const res = await api(`/api/files/${id}`, { method: 'DELETE' });
    if (!res.ok) toast('Could not delete file', true);
  }

  function render() {
    list.innerHTML = '';
    $('#files-empty').style.display = store.files.length ? 'none' : 'block';
    for (const f of store.files) {
      const row = el('li', { class: 'file-row' });
      row.innerHTML = `
        <div class="grow">
          <div class="fname">${escapeHtml(f.name)}</div>
          <div class="fmeta">${fmtBytes(f.size)} · from ${f.from === 'mac' ? 'the Mac' : 'the phone'} · ${fmtTime(f.ts)}</div>
        </div>
        <a class="aero-btn mini" href="${withToken(`/api/files/${f.id}/download`)}" download>Save</a>
        <button class="aero-btn ghost mini" data-del="${f.id}">✕</button>`;
      row.querySelector('[data-del]').addEventListener('click', () => removeFile(f.id));
      list.appendChild(row);
    }
  }
  store.on(render);
  render();

  return {};
}

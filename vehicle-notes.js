// ============================================================
// DriverTrax Vehicle Notes — shared widget
//   Mountable read+add view. Any signed-in role can mount it to
//   surface the cross-role notes on a VIN (driver entry panel,
//   record detail overlay, etc).
// ============================================================

(function () {
  if (!window.DT_AUTH) return;
  const sb = DT_AUTH.client;
  const esc = (s) => String(s || "").replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
  const ago = (d) => (window.dtTimeAgo ? window.dtTimeAgo(d) : new Date(d).toLocaleString());
  const profileCache = new Map();

  async function fetchProfileNames(ids) {
    const missing = [...new Set(ids)].filter(id => id && !profileCache.has(id));
    if (!missing.length) return;
    const { data } = await sb.from("profiles").select("id,display_name,role").in("id", missing);
    (data || []).forEach(p => profileCache.set(p.id, p));
  }

  // Mount a notes view for `vin` inside `container`. Re-mountable: clears + rebuilds.
  async function mount(container, vin) {
    if (!container) return;
    if (!vin) { container.innerHTML = ""; return; }
    container.classList.add("vn-mount");
    container.innerHTML = `
      <div class="vn-head">
        <span class="vn-title">Notes on this VIN</span>
        <button type="button" class="vn-add-toggle" data-state="closed">+ Add a note</button>
      </div>
      <div class="vn-list"><div class="bl-empty">Loading…</div></div>
      <form class="vn-add-form" style="display:none">
        <textarea name="body" placeholder="What should the next person know?" required maxlength="1000"></textarea>
        <button type="submit" class="btn btn-primary">Save Note</button>
      </form>
    `;
    container.dataset.vin = vin;

    const toggle = container.querySelector(".vn-add-toggle");
    const form = container.querySelector(".vn-add-form");
    toggle.addEventListener("click", () => {
      const open = toggle.dataset.state !== "open";
      toggle.dataset.state = open ? "open" : "closed";
      toggle.textContent = open ? "Cancel" : "+ Add a note";
      form.style.display = open ? "flex" : "none";
      if (open) form.querySelector("textarea").focus();
    });
    form.addEventListener("submit", (e) => onAdd(e, container, vin));

    await refresh(container, vin);
  }

  async function refresh(container, vin) {
    const list = container.querySelector(".vn-list");
    if (!list) return;
    const { data, error } = await sb
      .from("vehicle_notes")
      .select("id,body,author_id,created_at,archived,lat,lng,photo_url")
      .eq("serial_id", vin)
      .eq("archived", false)
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) { list.innerHTML = `<div class="bl-empty">${esc(error.message)}</div>`; return; }
    if (!data || !data.length) {
      list.innerHTML = `<div class="vn-empty">No notes yet for this VIN.</div>`;
      return;
    }
    await fetchProfileNames(data.map(n => n.author_id));

    // Sign all photo paths in one round trip
    const photoPaths = [...new Set(data.filter(n => n.photo_url).map(n => n.photo_url))];
    const signed = {};
    if (photoPaths.length) {
      const { data: urls } = await sb.storage.from("vehicle-photos").createSignedUrls(photoPaths, 600);
      (urls || []).forEach(u => { signed[u.path] = u.signedUrl; });
    }

    const myId = DT_AUTH.getUser()?.id;
    list.innerHTML = data.map(n => {
      const p = profileCache.get(n.author_id);
      const name = p?.display_name || "Someone";
      const roleLabel = p?.role ? ` <span class="note-role role-${esc(p.role)}">${esc(p.role)}</span>` : "";
      const mine = n.author_id === myId;
      const photoHtml = n.photo_url && signed[n.photo_url]
        ? `<div class="note-photo"><img src="${esc(signed[n.photo_url])}" alt="" data-full="${esc(signed[n.photo_url])}"></div>`
        : "";
      const gpsHtml = (Number.isFinite(n.lat) && Number.isFinite(n.lng))
        ? `<a class="note-gps" href="https://www.google.com/maps?q=${n.lat},${n.lng}" target="_blank" rel="noopener">📍 Location</a>`
        : "";
      return `
        <div class="note-card" data-id="${n.id}">
          <div class="note-head">
            <span class="note-author">${esc(name)}${roleLabel}</span>
            <span class="note-time">${esc(ago(n.created_at))}</span>
          </div>
          <div class="note-body">${esc(n.body)}</div>
          ${photoHtml}
          ${gpsHtml}
          ${mine ? `<button class="note-del" data-id="${n.id}">delete</button>` : ""}
        </div>
      `;
    }).join("");
    list.querySelectorAll(".note-del").forEach(b => b.addEventListener("click", async () => {
      if (!confirm("Delete this note?")) return;
      const { error } = await sb.from("vehicle_notes").delete().eq("id", b.dataset.id);
      if (error) { alert(error.message); return; }
      refresh(container, vin);
    }));
    list.querySelectorAll(".note-photo img").forEach(img => {
      img.addEventListener("click", () => openPhotoViewer(img.dataset.full));
    });
  }

  async function onAdd(e, container, vin) {
    e.preventDefault();
    const form = e.target;
    const body = (new FormData(form).get("body") || "").trim();
    if (!body) return;
    const user = DT_AUTH.getUser();
    if (!user) return;
    const btn = form.querySelector("button[type=submit]");
    btn.disabled = true; btn.textContent = "Saving…";
    const { error } = await sb.from("vehicle_notes").insert({
      serial_id: vin,
      author_id: user.id,
      body
    });
    btn.disabled = false; btn.textContent = "Save Note";
    if (error) { alert(error.message); return; }
    form.reset();
    form.style.display = "none";
    const toggle = container.querySelector(".vn-add-toggle");
    toggle.dataset.state = "closed";
    toggle.textContent = "+ Add a note";
    refresh(container, vin);
  }

  function openPhotoViewer(url) {
    let v = document.getElementById("notePhotoViewer");
    if (!v) {
      v = document.createElement("div");
      v.id = "notePhotoViewer";
      v.className = "note-photo-viewer";
      v.innerHTML = `<img id="notePhotoViewerImg" alt=""><button id="notePhotoViewerClose">✕</button>`;
      document.body.appendChild(v);
      v.addEventListener("click", (e) => { if (e.target === v || e.target.id === "notePhotoViewerClose") v.classList.remove("show"); });
    }
    document.getElementById("notePhotoViewerImg").src = url;
    v.classList.add("show");
  }

  window.DT_VNOTES = { mount, refresh };
})();

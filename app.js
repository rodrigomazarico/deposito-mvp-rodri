(() => {
  "use strict";

  const STORAGE_KEYS = Object.freeze({
    providers: "deposito:Proveedores",
    orders: "deposito:Pedidos",
    invoices: "deposito:Facturas_Y_Pagos",
  });
  const OPENROUTER_DEFAULTS = Object.freeze({
    baseUrl: "https://openrouter.ai/api/v1",
    model: "google/gemma-3-4b-it",
  });
  const MAX_FILE_BYTES = 12 * 1024 * 1024;
  const MAX_PERSISTED_FILE_BYTES = 3 * 1024 * 1024;
  const PENDING_ALERT_DAYS = 7;

  const state = {
    providers: readCollection(STORAGE_KEYS.providers).map(normalizeProvider),
    orders: readCollection(STORAGE_KEYS.orders),
    invoices: readCollection(STORAGE_KEYS.invoices),
    itemRows: [{ description: "", quantity: 1 }],
    receptionDrafts: new Map(),
    directPurchaseDraft: null,
    directPurchaseOpen: false,
    providerDialogId: null,
    paymentInvoiceId: null,
  };

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [
    ...root.querySelectorAll(selector),
  ];

  function readCollection(key) {
    try {
      const value = JSON.parse(localStorage.getItem(key) || "[]");
      return Array.isArray(value) ? value : [];
    } catch {
      return [];
    }
  }

  function saveCollections() {
    const providers = JSON.stringify(state.providers);
    const orders = JSON.stringify(state.orders);
    const invoices = JSON.stringify(state.invoices);
    try {
      localStorage.setItem(STORAGE_KEYS.providers, providers);
      localStorage.setItem(STORAGE_KEYS.orders, orders);
      localStorage.setItem(STORAGE_KEYS.invoices, invoices);
    } catch {
      const fallbackInvoices = state.invoices.map((invoice) =>
        invoice.file?.dataUrl
          ? {
              ...invoice,
              file: {
                ...invoice.file,
                dataUrl: undefined,
                previewUnavailable: true,
              },
            }
          : invoice,
      );
      state.invoices = fallbackInvoices;
      localStorage.setItem(STORAGE_KEYS.providers, providers);
      localStorage.setItem(STORAGE_KEYS.orders, orders);
      localStorage.setItem(
        STORAGE_KEYS.invoices,
        JSON.stringify(fallbackInvoices),
      );
      showToast(
        "Datos guardados; el archivo excede el espacio local de vista previa.",
      );
    }
  }

  function id(prefix) {
    if (globalThis.crypto?.randomUUID)
      return `${prefix}_${crypto.randomUUID()}`;
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  }

  function now() {
    return new Date().toISOString();
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function formatDate(value) {
    if (!value) return "—";
    return new Intl.DateTimeFormat("es-AR", { dateStyle: "short" }).format(
      new Date(value),
    );
  }

  function formatCurrency(value) {
    return new Intl.NumberFormat("es-AR", {
      style: "currency",
      currency: "ARS",
    }).format(Number(value) || 0);
  }

  function parseMoney(value) {
    if (typeof value === "number") return Number.isFinite(value) ? value : 0;
    let text = String(value ?? "")
      .trim()
      .replace(/\s/g, "")
      .replace(/[^\d,.-]/g, "");
    if (!text) return 0;
    if (text.includes(",") && text.includes(".")) {
      text =
        text.lastIndexOf(",") > text.lastIndexOf(".")
          ? text.replaceAll(".", "").replace(",", ".")
          : text.replaceAll(",", "");
    } else if (text.includes(",")) {
      text = text.replace(",", ".");
    }
    const parsed = Number(text);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function normalizedName(value) {
    return String(value || "")
      .trim()
      .replace(/\s+/g, " ");
  }

  function normalizedPhone(value) {
    return String(value || "")
      .trim()
      .replace(/[^\d+]/g, "");
  }

  function whatsappNumber(value) {
    let digits = normalizedPhone(value).replace(/\D/g, "");
    if (digits.startsWith("00")) digits = digits.slice(2);
    return digits.length >= 10 && digits.length <= 15 ? digits : "";
  }

  function emptyProviderMemory() {
    return {
      samples: 0,
      lastLearnedAt: null,
      taxId: "",
      taxCondition: "",
      address: "",
      invoiceTemplate: {
        invoiceNumberPrefix: "",
        invoiceNumberPattern: "",
        expectedFields: [],
        itemColumns: [],
        fieldLabels: [],
      },
    };
  }

  function normalizeList(values, limit = 20) {
    return Array.isArray(values)
      ? values
          .map((value) => normalizedName(value))
          .filter(Boolean)
          .slice(0, limit)
      : [];
  }

  function normalizeProviderMemory(memory) {
    const defaults = emptyProviderMemory();
    const source = memory && typeof memory === "object" ? memory : {};
    const template =
      source.invoiceTemplate && typeof source.invoiceTemplate === "object"
        ? source.invoiceTemplate
        : {};
    return {
      ...defaults,
      ...source,
      samples: Math.max(0, Number(source.samples) || 0),
      taxId: normalizedName(source.taxId),
      taxCondition: normalizedName(source.taxCondition),
      address: normalizedName(source.address),
      invoiceTemplate: {
        ...defaults.invoiceTemplate,
        ...template,
        expectedFields: normalizeList(template.expectedFields),
        itemColumns: normalizeList(template.itemColumns),
        fieldLabels: normalizeList(template.fieldLabels),
      },
    };
  }

  function normalizeProvider(provider) {
    const source = provider && typeof provider === "object" ? provider : {};
    return {
      ...source,
      name: normalizedName(source.name),
      phone: normalizedPhone(source.phone || source.whatsappPhone),
      memory: normalizeProviderMemory(source.memory),
    };
  }

  function providerForOrder(order) {
    if (!order) return null;
    return (
      state.providers.find((provider) => provider.id === order.providerId) ||
      state.providers.find(
        (provider) =>
          provider.name.toLocaleLowerCase() ===
          normalizedName(order.providerName).toLocaleLowerCase(),
      ) ||
      null
    );
  }

  function getOrCreateProvider(name, phone = "") {
    const providerName = normalizedName(name);
    const providerPhone = normalizedPhone(phone);
    const existing = state.providers.find(
      (provider) =>
        provider.name.toLocaleLowerCase() === providerName.toLocaleLowerCase(),
    );
    if (existing) {
      existing.memory = normalizeProviderMemory(existing.memory);
      if (providerPhone) existing.phone = providerPhone;
      return existing;
    }
    const provider = {
      id: id("prov"),
      name: providerName,
      phone: providerPhone,
      createdAt: now(),
      memory: emptyProviderMemory(),
    };
    state.providers.push(provider);
    return provider;
  }

  function invoiceNumberPattern(value) {
    return String(value || "")
      .trim()
      .replace(/[A-ZÁÉÍÓÚÑ]/gi, "A")
      .replace(/\d/g, "0");
  }

  function invoiceNumberPrefix(value) {
    const match = String(value || "")
      .trim()
      .match(/^[A-ZÁÉÍÓÚÑ]+/i);
    return match ? match[0].toUpperCase() : "";
  }

  function learnProviderFromInvoice(provider, draft, invoice) {
    const memory = normalizeProviderMemory(provider.memory);
    const template = memory.invoiceTemplate;
    const learnedFields = [
      "providerName",
      "taxId",
      "taxCondition",
      "invoiceNumber",
      "invoiceDate",
      "total",
      "items",
    ];
    memory.taxId = normalizedName(draft.taxId) || memory.taxId;
    memory.taxCondition =
      normalizedName(draft.taxCondition) || memory.taxCondition;
    memory.address = normalizedName(draft.address) || memory.address;
    template.invoiceNumberPrefix =
      invoiceNumberPrefix(invoice.invoiceNumber) ||
      template.invoiceNumberPrefix;
    template.invoiceNumberPattern = invoiceNumberPattern(invoice.invoiceNumber);
    template.expectedFields = [
      ...new Set([...template.expectedFields, ...learnedFields]),
    ].slice(0, 20);
    template.itemColumns = [
      ...new Set([
        ...template.itemColumns,
        ...(draft.itemColumns || []),
        "description",
        "quantity",
      ]),
    ].slice(0, 12);
    template.fieldLabels = [
      ...new Set([...template.fieldLabels, ...(draft.fieldLabels || [])]),
    ].slice(0, 20);
    memory.samples += 1;
    memory.lastLearnedAt = now();
    provider.memory = memory;
  }

  function getMemoryPrompt(order) {
    const provider = providerForOrder(order);
    const memory = provider?.memory;
    if (!provider || !memory || memory.samples < 1) {
      return "No hay memoria previa confiable para este proveedor.";
    }
    const template = memory.invoiceTemplate;
    return [
      `Memoria previa de ${provider.name} (${memory.samples} factura(s) confirmada(s)):`,
      memory.taxId ? `- ID fiscal conocido: ${memory.taxId}` : "",
      memory.taxCondition
        ? `- Condición fiscal conocida: ${memory.taxCondition}`
        : "",
      memory.address ? `- Dirección fiscal conocida: ${memory.address}` : "",
      template.invoiceNumberPrefix
        ? `- Prefijo habitual de factura: ${template.invoiceNumberPrefix}`
        : "",
      template.invoiceNumberPattern
        ? `- Estructura habitual del número: ${template.invoiceNumberPattern}`
        : "",
      template.itemColumns.length
        ? `- Columnas de ítems observadas: ${template.itemColumns.join(", ")}`
        : "",
      template.fieldLabels.length
        ? `- Etiquetas observadas: ${template.fieldLabels.join(", ")}`
        : "",
      "Usá esta memoria como pista para leer la nueva factura, pero priorizá siempre el comprobante actual y no inventes valores.",
    ]
      .filter(Boolean)
      .join("\\n");
  }

  function getOrder(orderId) {
    return state.orders.find((order) => order.id === orderId);
  }

  function getInvoiceForOrder(orderId) {
    return state.invoices.find((invoice) => invoice.orderId === orderId);
  }

  function getInvoice(invoiceId) {
    return state.invoices.find((invoice) => invoice.id === invoiceId);
  }

  function paymentStatus(invoice) {
    if (!invoice) return "pending";
    const total = Number(invoice.total) || 0;
    const paid = (invoice.payments || []).reduce(
      (sum, payment) => sum + (Number(payment.amount) || 0),
      0,
    );
    if (total > 0 && paid >= total - 0.01) return "paid";
    if (paid > 0) return "partial";
    return "pending";
  }

  function paidAmount(invoice) {
    return (invoice?.payments || []).reduce(
      (sum, payment) => sum + (Number(payment.amount) || 0),
      0,
    );
  }

  function invoiceAgeDays(invoice, order) {
    const sourceDate =
      invoice?.createdAt || order?.receivedAt || order?.createdAt;
    if (!sourceDate) return 0;
    const timestamp = new Date(sourceDate).getTime();
    if (!Number.isFinite(timestamp)) return 0;
    return Math.max(0, Math.floor((Date.now() - timestamp) / 86400000));
  }

  function isPaymentAlert(invoice, order) {
    const status = paymentStatus(invoice);
    return (
      status !== "paid" && invoiceAgeDays(invoice, order) >= PENDING_ALERT_DAYS
    );
  }

  function statusLabel(status) {
    return (
      { paid: "Pagada", partial: "Pago parcial", pending: "Pendiente" }[
        status
      ] || "Pendiente"
    );
  }

  function itemsFromRows(rows) {
    return rows
      .map((row) => ({
        description: normalizedName(row.description),
        quantity: Math.max(1, Number(row.quantity) || 1),
      }))
      .filter((row) => row.description);
  }

  function renderItemRows(container, rows, mode = "order") {
    container.innerHTML = rows
      .map(
        (row, index) => `
      <div class="item-row" data-index="${index}">
        <input data-item-field="description" value="${escapeHtml(row.description)}" placeholder="Descripción" aria-label="Descripción del ítem">
        <input data-item-field="quantity" type="number" min="1" step="1" value="${escapeHtml(row.quantity || 1)}" aria-label="Cantidad">
        <button class="remove-item" type="button" data-remove-item="${index}" aria-label="Quitar ítem">×</button>
      </div>
    `,
      )
      .join("");
    if (mode === "order" && !rows.length)
      container.innerHTML = '<p class="muted">Agregá al menos un ítem.</p>';
  }

  function readRenderedItemRows(container) {
    return $$(".item-row", container).map((row) => ({
      description: $('[data-item-field="description"]', row)?.value || "",
      quantity: $('[data-item-field="quantity"]', row)?.value || 1,
    }));
  }

  function findProviderByName(name) {
    const providerName = normalizedName(name).toLocaleLowerCase();
    return state.providers.find(
      (provider) => provider.name.toLocaleLowerCase() === providerName,
    );
  }

  function prefillProviderPhone() {
    const provider = findProviderByName($("#order-supplier").value);
    const phoneInput = $("#order-provider-phone");
    if (!phoneInput) return;
    if (provider?.phone) {
      phoneInput.value = provider.phone;
      phoneInput.dataset.providerName = provider.name;
    } else if (phoneInput.dataset.providerName) {
      phoneInput.value = "";
      delete phoneInput.dataset.providerName;
    }
  }

  function createWhatsAppLink(provider, items) {
    const number = whatsappNumber(provider.phone);
    if (!number) return "";
    const detail = items
      .map((item) => `• ${item.quantity} × ${item.description}`)
      .join("\\n");
    const message = `Hola ${provider.name}, te pasamos el nuevo pedido:\\n\\n${detail}\\n\\n¡Gracias!`;
    return `https://wa.me/${number}?text=${encodeURIComponent(message)}`;
  }

  function renderProviderOptions() {
    $("#supplier-options").innerHTML = state.providers
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name, "es"))
      .map(
        (provider) => `<option value="${escapeHtml(provider.name)}"></option>`,
      )
      .join("");
  }

  function renderWarehouse() {
    renderProviderOptions();
    const pending = state.orders.filter(
      (order) => order.status === "Pendiente",
    );
    $("#warehouse-count").textContent =
      `${pending.length} pendiente${pending.length === 1 ? "" : "s"}`;
    const container = $("#pending-orders");
    $("#empty-pending").classList.toggle("hidden", pending.length > 0);
    container.innerHTML = pending
      .map((order) => renderPendingOrder(order))
      .join("");
    renderDirectPurchase();
  }

  function renderPendingOrder(order) {
    const draft = state.receptionDrafts.get(order.id);
    const selected = Boolean(draft);
    const items = (order.items || [])
      .map(
        (item) =>
          `${escapeHtml(item.quantity)} × ${escapeHtml(item.description)}`,
      )
      .join(" · ");
    return `
      <div class="pending-order ${selected ? "is-selected" : ""}" data-order-id="${escapeHtml(order.id)}">
        <div class="pending-order-header">
          <div>
            <div class="pending-order-title">${escapeHtml(order.providerName)}</div>
            <div class="pending-order-meta">Pedido del ${formatDate(order.createdAt)}${order.note ? ` · ${escapeHtml(order.note)}` : ""}</div>
          </div>
          <span class="status-chip status-received">Pendiente</span>
        </div>
        <p class="order-items-preview">${items || "Sin ítems detallados"}</p>
        <div class="receive-actions">
          <label class="file-input-wrap">
            Foto o PDF de factura
            <input type="file" accept="image/*,application/pdf" data-invoice-file>
          </label>
          <button class="secondary-button ocr-button" type="button" data-action="ocr" ${draft?.busy ? "disabled" : ""}>${draft?.busy ? "Procesando…" : "Extraer con OCR"}</button>
        </div>
        <button class="text-button" type="button" data-action="manual">Completar factura manualmente</button>
        ${draft ? renderReceptionForm(order, draft) : ""}
      </div>
    `;
  }

  function renderReceptionForm(order, draft, options = {}) {
    const direct = options.direct === true;
    const items = draft.items?.length
      ? draft.items
      : [{ description: "", quantity: 1 }];
    const selectedFile = draft.file
      ? `Archivo: ${escapeHtml(draft.file.name)}`
      : "Sin archivo asociado";
    const memoryNote = draft.memoryApplied
      ? `<div class="memory-hint"><span class="memory-icon" aria-hidden="true">✦</span> Memoria de ${escapeHtml(draft.memoryProviderName)} aplicada: campos fiscales y formato habitual sugeridos.</div>`
      : "";
    return `
      <form class="receiving-form" data-receiving-form ${direct ? "data-direct-receiving-form" : ""}>
        <div class="muted">${selectedFile}${draft.source === "ocr" ? " · Datos extraídos, revisalos antes de confirmar" : ""}</div>
        ${memoryNote}
        <div class="receiving-grid">
          <label>Proveedor<input data-draft-field="providerName" value="${escapeHtml(draft.providerName || order.providerName || "")}" required></label>
          <label>ID fiscal / CUIT<input data-draft-field="taxId" value="${escapeHtml(draft.taxId || "")}" placeholder="30-12345678-9"></label>
          <label>Condición fiscal<input data-draft-field="taxCondition" value="${escapeHtml(draft.taxCondition || "")}" placeholder="Responsable inscripto"></label>
          <label>Número de factura<input data-draft-field="invoiceNumber" value="${escapeHtml(draft.invoiceNumber || "")}" placeholder="A-0001-00001234" required></label>
          <label>Monto total<input data-draft-field="total" value="${escapeHtml(draft.total || "")}" inputmode="decimal" placeholder="0,00" required></label>
          <label>Fecha<input data-draft-field="invoiceDate" type="date" value="${escapeHtml(draft.invoiceDate || "")}"></label>
          <label class="field-span-full">Dirección fiscal<input data-draft-field="address" value="${escapeHtml(draft.address || "")}" placeholder="Opcional"></label>
        </div>
        ${direct ? `<label>Estado de pago<select data-draft-field="directPaymentMode"><option value="pending" ${draft.directPaymentMode !== "cash" ? "selected" : ""}>Pendiente / cuenta corriente</option><option value="cash" ${draft.directPaymentMode === "cash" ? "selected" : ""}>Pagado al contado</option></select></label>` : ""}
        <div class="field-label-row"><span>Ítems recibidos</span><button class="text-button" type="button" data-action="add-receiving-item">+ Agregar ítem</button></div>
        <div class="receiving-items" data-receiving-items>
          ${items
            .map(
              (item, index) => `
            <div class="item-row" data-index="${index}">
              <input data-item-field="description" value="${escapeHtml(item.description)}" placeholder="Descripción" required>
              <input data-item-field="quantity" type="number" min="1" step="1" value="${escapeHtml(item.quantity || 1)}" aria-label="Cantidad">
              <button class="remove-item" type="button" data-remove-receiving-item="${index}" aria-label="Quitar ítem">×</button>
            </div>
          `,
            )
            .join("")}
        </div>
        <button class="primary-button" type="submit">${direct ? "Guardar compra directa" : "Confirmar recepción"}</button>
        <p class="form-message ${draft.error ? "is-error" : ""}" data-draft-message>${escapeHtml(draft.error || "")}</p>
      </form>
    `;
  }

  function createDirectDraft() {
    return {
      providerName: "",
      taxId: "",
      taxCondition: "",
      address: "",
      invoiceNumber: "",
      total: "",
      invoiceDate: "",
      items: [{ description: "", quantity: 1 }],
      fieldLabels: [],
      itemColumns: [],
      directPaymentMode: "pending",
      memoryApplied: false,
      memoryProviderName: "",
      formVisible: false,
      file: null,
      fileObject: null,
      source: "manual",
      busy: false,
      error: "",
    };
  }

  function applyProviderMemoryToDraft(draft, provider) {
    const memory = provider?.memory || emptyProviderMemory();
    if (!provider || memory.samples < 1) {
      draft.memoryApplied = false;
      draft.memoryProviderName = provider?.name || "";
      return draft;
    }
    draft.taxId = draft.taxId || memory.taxId;
    draft.taxCondition = draft.taxCondition || memory.taxCondition;
    draft.address = draft.address || memory.address;
    draft.fieldLabels = draft.fieldLabels.length
      ? draft.fieldLabels
      : memory.invoiceTemplate.fieldLabels;
    draft.itemColumns = draft.itemColumns.length
      ? draft.itemColumns
      : memory.invoiceTemplate.itemColumns;
    draft.memoryApplied = true;
    draft.memoryProviderName = provider.name;
    return draft;
  }

  function renderDirectPurchase() {
    const card = $("#quick-purchase-card");
    if (!card) return;
    card.classList.toggle("hidden", !state.directPurchaseOpen);
    if (!state.directPurchaseOpen) return;
    const draft = state.directPurchaseDraft || createDirectDraft();
    state.directPurchaseDraft = draft;
    const providerHint = $("#direct-provider-hint");
    if (providerHint && draft.providerName)
      providerHint.value = draft.providerName;
    $("#direct-ocr-button").disabled = draft.busy;
    $("#direct-ocr-button").textContent = draft.busy
      ? "Procesando…"
      : "Extraer con OCR";
    $("#direct-purchase-form").innerHTML = draft.formVisible
      ? renderReceptionForm({ providerName: draft.providerName }, draft, {
          direct: true,
        })
      : "";
  }

  function openDirectPurchase() {
    state.directPurchaseOpen = true;
    state.directPurchaseDraft = createDirectDraft();
    $("#direct-provider-hint").value = "";
    $("#direct-invoice-file").value = "";
    renderDirectPurchase();
    $("#quick-purchase-card")?.scrollIntoView({
      behavior: "smooth",
      block: "start",
    });
  }

  function closeDirectPurchase() {
    state.directPurchaseOpen = false;
    state.directPurchaseDraft = null;
    renderDirectPurchase();
  }

  async function processDirectOcr() {
    const draft = state.directPurchaseDraft || createDirectDraft();
    const file = draft.fileObject || $("#direct-invoice-file")?.files?.[0];
    if (!file) {
      draft.error = "Seleccioná una foto o PDF antes de procesar.";
      draft.formVisible = true;
      state.directPurchaseDraft = draft;
      renderDirectPurchase();
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      draft.error = "El archivo supera el límite de 12 MB.";
      draft.formVisible = true;
      state.directPurchaseDraft = draft;
      renderDirectPurchase();
      return;
    }
    draft.fileObject = file;
    draft.file = { name: file.name, type: file.type, size: file.size };
    draft.busy = true;
    draft.formVisible = true;
    draft.error = "";
    state.directPurchaseDraft = draft;
    renderDirectPurchase();
    try {
      const extracted = await extractInvoiceWithOpenRouter(file, {
        providerName: draft.providerName || "el proveedor de la factura",
      });
      const provider = findProviderByName(extracted.providerName);
      Object.assign(draft, extracted, {
        items: extracted.items.length ? extracted.items : draft.items,
        busy: false,
        source: "ocr",
        error: "",
      });
      applyProviderMemoryToDraft(draft, provider);
      state.directPurchaseDraft = draft;
      renderDirectPurchase();
      showToast("Factura directa extraída. Revisá y confirmá.");
    } catch (error) {
      draft.busy = false;
      draft.error =
        error instanceof Error
          ? error.message
          : "No se pudo procesar la factura.";
      state.directPurchaseDraft = draft;
      renderDirectPurchase();
    }
  }

  async function confirmDirectPurchase(event, card) {
    event.preventDefault();
    const draft = state.directPurchaseDraft || createDirectDraft();
    syncDraftFromForm(card, draft);
    const providerName = normalizedName(draft.providerName);
    const invoiceNumber = String(draft.invoiceNumber || "").trim();
    const total = parseMoney(draft.total);
    const items = itemsFromRows(draft.items || []);
    if (!providerName || !invoiceNumber || total <= 0 || !items.length) {
      draft.error =
        "Completá proveedor, número, monto mayor a cero y al menos un ítem.";
      state.directPurchaseDraft = draft;
      renderDirectPurchase();
      return;
    }
    const submitButton = $("button[type=submit]", card);
    if (submitButton) submitButton.disabled = true;
    let file = draft.file;
    try {
      file = await persistInvoiceFile(draft);
    } catch {
      draft.error = "No se pudo preparar el archivo para la previsualización.";
      state.directPurchaseDraft = draft;
      renderDirectPurchase();
      return;
    }
    const provider = getOrCreateProvider(providerName);
    const order = {
      id: id("ord"),
      providerId: provider.id,
      providerName: provider.name,
      providerPhone: provider.phone || "",
      items,
      note: "Compra rápida / factura directa",
      status: "Recibido",
      source: "direct",
      createdAt: now(),
      receivedAt: now(),
      invoiceId: null,
    };
    const invoice = {
      id: id("inv"),
      orderId: order.id,
      providerId: provider.id,
      providerName: provider.name,
      invoiceNumber,
      invoiceDate: normalizeDate(draft.invoiceDate) || null,
      total,
      items,
      currency: "ARS",
      file,
      extraction: draft.source || "manual",
      paymentMode: draft.directPaymentMode === "cash" ? "cash" : "account",
      payments:
        draft.directPaymentMode === "cash"
          ? [
              {
                id: id("pay"),
                amount: total,
                date: now(),
                note: "Compra directa al contado",
                mode: "cash",
              },
            ]
          : [],
      createdAt: now(),
    };
    order.invoiceId = invoice.id;
    learnProviderFromInvoice(provider, draft, invoice);
    state.orders.unshift(order);
    state.invoices.push(invoice);
    saveCollections();
    closeDirectPurchase();
    renderWarehouse();
    renderAdmin();
    showToast(
      draft.directPaymentMode === "cash"
        ? "Compra directa guardada y pagada"
        : "Compra directa guardada como pendiente",
    );
  }

  function createOrder(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const providerName = normalizedName($("#order-supplier").value);
    const providerPhone = normalizedPhone($("#order-provider-phone").value);
    const items = itemsFromRows(readRenderedItemRows($("#order-items")));
    const message = $("#order-form-message");
    message.classList.remove("is-error");
    if (!providerName || !items.length) {
      message.textContent = "Indicá un proveedor y al menos un ítem.";
      message.classList.add("is-error");
      return;
    }
    if (!whatsappNumber(providerPhone)) {
      message.textContent =
        "Indicá un teléfono válido con código de país, por ejemplo +54 9 11 1234-5678.";
      message.classList.add("is-error");
      return;
    }
    const provider = getOrCreateProvider(providerName, providerPhone);
    const whatsappUrl = createWhatsAppLink(provider, items);
    const order = {
      id: id("ord"),
      providerId: provider.id,
      providerName: provider.name,
      providerPhone: provider.phone,
      items,
      note: normalizedName($("#order-note").value),
      status: "Pendiente",
      createdAt: now(),
      receivedAt: null,
      invoiceId: null,
      whatsappUrl,
    };
    state.orders.unshift(order);
    saveCollections();
    form.reset();
    state.itemRows = [{ description: "", quantity: 1 }];
    renderItemRows($("#order-items"), state.itemRows);
    const whatsappWindow = window.open(
      whatsappUrl,
      "_blank",
      "noopener,noreferrer",
    );
    message.innerHTML = `Pedido guardado. Ya aparece en Recepción con factura. <a class="whatsapp-link" href="${escapeHtml(whatsappUrl)}" target="_blank" rel="noopener noreferrer">${whatsappWindow ? "WhatsApp abierto" : "Abrir WhatsApp"} ↗</a>`;
    showToast("Pedido creado y WhatsApp preparado");
    renderWarehouse();
  }

  function selectFile(orderId, file) {
    const previous =
      state.receptionDrafts.get(orderId) || createDraft(getOrder(orderId));
    previous.fileObject = file || null;
    previous.file = file
      ? { name: file.name, type: file.type, size: file.size }
      : null;
    previous.error = "";
    state.receptionDrafts.set(orderId, previous);
    renderWarehouse();
  }

  function createDraft(order) {
    const provider = providerForOrder(order);
    const memory = provider?.memory || emptyProviderMemory();
    return {
      providerName: order.providerName,
      taxId: memory.taxId,
      taxCondition: memory.taxCondition,
      address: memory.address,
      invoiceNumber: "",
      total: "",
      invoiceDate: "",
      items: (order.items || []).map((item) => ({ ...item })),
      fieldLabels: memory.invoiceTemplate.fieldLabels,
      itemColumns: memory.invoiceTemplate.itemColumns,
      memoryApplied: memory.samples > 0,
      memoryProviderName: provider?.name || order.providerName,
      file: null,
      fileObject: null,
      source: "manual",
      busy: false,
      error: "",
    };
  }

  async function processOcr(orderId, card) {
    const fileInput = $("[data-invoice-file]", card);
    const draft =
      state.receptionDrafts.get(orderId) || createDraft(getOrder(orderId));
    const file = draft.fileObject || fileInput?.files?.[0];
    if (!file) {
      const draft =
        state.receptionDrafts.get(orderId) || createDraft(getOrder(orderId));
      draft.error = "Seleccioná una foto o PDF antes de procesar.";
      state.receptionDrafts.set(orderId, draft);
      renderWarehouse();
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      const draft =
        state.receptionDrafts.get(orderId) || createDraft(getOrder(orderId));
      draft.error = "El archivo supera el límite de 12 MB.";
      state.receptionDrafts.set(orderId, draft);
      renderWarehouse();
      return;
    }
    draft.fileObject = file;
    draft.file = { name: file.name, type: file.type, size: file.size };
    draft.busy = true;
    draft.error = "";
    state.receptionDrafts.set(orderId, draft);
    renderWarehouse();
    try {
      const extracted = await extractInvoiceWithOpenRouter(
        file,
        getOrder(orderId),
      );
      Object.assign(draft, extracted, {
        taxId: extracted.taxId || draft.taxId,
        taxCondition: extracted.taxCondition || draft.taxCondition,
        address: extracted.address || draft.address,
        fieldLabels: extracted.fieldLabels.length
          ? extracted.fieldLabels
          : draft.fieldLabels,
        itemColumns: extracted.itemColumns.length
          ? extracted.itemColumns
          : draft.itemColumns,
        items: extracted.items.length ? extracted.items : draft.items,
        busy: false,
        source: "ocr",
        error: "",
      });
      state.receptionDrafts.set(orderId, draft);
      renderWarehouse();
      showToast("Factura extraída. Revisá los datos y confirmá.");
    } catch (error) {
      draft.busy = false;
      draft.error =
        error instanceof Error
          ? error.message
          : "No se pudo procesar la factura.";
      state.receptionDrafts.set(orderId, draft);
      renderWarehouse();
    }
  }

  async function extractInvoiceWithOpenRouter(file, order) {
    const key = $("#openrouter-key").value.trim();
    const model =
      $("#openrouter-model").value.trim() || OPENROUTER_DEFAULTS.model;
    const baseUrl = (
      $("#openrouter-base-url").value.trim() || OPENROUTER_DEFAULTS.baseUrl
    ).replace(/\/$/, "");
    const memoryPrompt = getMemoryPrompt(order);
    const useBrowserProxy = !key;
    if (!useBrowserProxy && !/^https:\/\//i.test(baseUrl))
      throw new Error("La Base URL debe comenzar con https://.");
    const dataUrl = await readAsDataUrl(file);
    const attachment =
      file.type === "application/pdf"
        ? { type: "file", file: { filename: file.name, file_data: dataUrl } }
        : { type: "image_url", image_url: { url: dataUrl } };
    const response = await fetch(
      useBrowserProxy ? "/api/ocr" : `${baseUrl}/chat/completions`,
      {
        method: "POST",
        headers: {
          ...(useBrowserProxy ? {} : { Authorization: `Bearer ${key}` }),
          "Content-Type": "application/json",
          "HTTP-Referer": window.location.href,
          "X-Title": "Depósito MVP",
        },
        body: JSON.stringify({
          model,
          temperature: 0,
          messages: [
            {
              role: "system",
              content:
                'Sos un extractor de facturas. Respondé únicamente JSON válido, sin markdown, con esta forma: {"providerName":"string","taxId":"string","taxCondition":"string","address":"string","invoiceNumber":"string","invoiceDate":"YYYY-MM-DD o vacío","total":number,"items":[{"description":"string","quantity":number}],"fieldLabels":["string"],"itemColumns":["string"]}. No inventes datos: usá vacío, [] o 0 cuando no sean legibles. fieldLabels e itemColumns describen solo etiquetas y columnas visibles en el comprobante.',
            },
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: `Extraé los datos de esta factura. El pedido esperaba al proveedor "${order.providerName}". Priorizá los datos impresos en el comprobante.\n\n${memoryPrompt}`,
                },
                attachment,
              ],
            },
          ],
        }),
      },
    );
    const payload = await response.json().catch(() => ({}));
    if (!response.ok)
      throw new Error(
        payload.error?.message ||
          `OpenRouter respondió con error ${response.status}.`,
      );
    const raw = payload.choices?.[0]?.message?.content;
    const parsed = parseModelJson(raw);
    return {
      providerName: normalizedName(
        parsed.providerName || parsed.provider || order.providerName,
      ),
      taxId: normalizedName(parsed.taxId || parsed.tax_id || parsed.cuit),
      taxCondition: normalizedName(
        parsed.taxCondition || parsed.tax_condition || parsed.fiscalCondition,
      ),
      address: normalizedName(parsed.address || parsed.fiscalAddress),
      fieldLabels: normalizeList(parsed.fieldLabels || parsed.field_labels, 20),
      itemColumns: normalizeList(parsed.itemColumns || parsed.item_columns, 12),
      invoiceNumber: String(
        parsed.invoiceNumber || parsed.invoice_number || parsed.number || "",
      ).trim(),
      invoiceDate: normalizeDate(
        parsed.invoiceDate || parsed.invoice_date || parsed.date,
      ),
      total: parseMoney(parsed.total ?? parsed.amount ?? parsed.monto),
      items: Array.isArray(parsed.items)
        ? parsed.items
            .map((item) => ({
              description: normalizedName(
                item.description || item.name || item.item,
              ),
              quantity: Math.max(
                1,
                Number(item.quantity || item.qty || 1) || 1,
              ),
            }))
            .filter((item) => item.description)
        : [],
    };
  }

  function readAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () =>
        reject(new Error("No se pudo leer el archivo seleccionado."));
      reader.readAsDataURL(file);
    });
  }

  function parseModelJson(raw) {
    const text = Array.isArray(raw)
      ? raw.map((part) => part.text || "").join("")
      : String(raw || "");
    const cleaned = text
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();
    try {
      return JSON.parse(cleaned);
    } catch {
      /* try the first JSON object below */
    }
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1));
      } catch {
        /* fall through */
      }
    }
    throw new Error(
      "El modelo no devolvió JSON válido. Probá nuevamente o completá la factura manualmente.",
    );
  }

  function normalizeDate(value) {
    const text = String(value || "").trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
    const match = text.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})$/);
    if (!match) return "";
    const year = match[3].length === 2 ? `20${match[3]}` : match[3];
    return `${year}-${match[2].padStart(2, "0")}-${match[1].padStart(2, "0")}`;
  }

  function syncDraftFromForm(card, draft) {
    $$("[data-draft-field]", card).forEach((input) => {
      draft[input.dataset.draftField] = input.value;
    });
    draft.items = readRenderedItemRows($("[data-receiving-items]", card));
  }

  async function persistInvoiceFile(draft) {
    if (!draft.file || !draft.fileObject) return draft.file;
    if (
      draft.file.dataUrl ||
      draft.fileObject.size > MAX_PERSISTED_FILE_BYTES
    ) {
      return {
        ...draft.file,
        previewUnavailable: draft.fileObject.size > MAX_PERSISTED_FILE_BYTES,
      };
    }
    return {
      ...draft.file,
      dataUrl: await readAsDataUrl(draft.fileObject),
    };
  }

  async function confirmReception(event, orderId, card) {
    event.preventDefault();
    const order = getOrder(orderId);
    const draft = state.receptionDrafts.get(orderId) || createDraft(order);
    syncDraftFromForm(card, draft);
    const providerName = normalizedName(draft.providerName);
    const invoiceNumber = String(draft.invoiceNumber || "").trim();
    const total = parseMoney(draft.total);
    const items = itemsFromRows(draft.items || []);
    if (!providerName || !invoiceNumber || total <= 0 || !items.length) {
      draft.error =
        "Completá proveedor, número, monto mayor a cero y al menos un ítem.";
      state.receptionDrafts.set(orderId, draft);
      renderWarehouse();
      return;
    }

    const submitButton = $("button[type=submit]", card);
    if (submitButton) submitButton.disabled = true;
    let file = draft.file;
    try {
      file = await persistInvoiceFile(draft);
    } catch {
      draft.error = "No se pudo preparar el archivo para la previsualización.";
      state.receptionDrafts.set(orderId, draft);
      renderWarehouse();
      return;
    }

    const provider = getOrCreateProvider(providerName);
    const invoice = {
      id: id("inv"),
      orderId,
      providerId: provider.id,
      providerName: provider.name,
      invoiceNumber,
      invoiceDate: normalizeDate(draft.invoiceDate) || null,
      total,
      items,
      currency: "ARS",
      file,
      extraction: draft.source || "manual",
      payments: [],
      createdAt: now(),
    };
    learnProviderFromInvoice(provider, draft, invoice);
    state.invoices = state.invoices.filter((item) => item.orderId !== orderId);
    state.invoices.push(invoice);
    Object.assign(order, {
      providerId: provider.id,
      providerName: provider.name,
      status: "Recibido",
      receivedAt: now(),
      invoiceId: invoice.id,
    });
    state.receptionDrafts.delete(orderId);
    saveCollections();
    renderWarehouse();
    renderAdmin();
    showToast("Recepción confirmada y factura asociada");
  }

  function renderProviderFilter(orders) {
    const select = $("#admin-provider-filter");
    const current = select.value;
    const providers = [
      ...new Map(
        orders.map((order) => [
          order.providerId || order.providerName,
          {
            id: order.providerId || order.providerName,
            name: order.providerName,
          },
        ]),
      ).values(),
    ].sort((a, b) => a.name.localeCompare(b.name, "es"));
    select.innerHTML = `<option value="">Todos los proveedores</option>${providers
      .map(
        (provider) =>
          `<option value="${escapeHtml(provider.id)}">${escapeHtml(provider.name)}</option>`,
      )
      .join("")}`;
    if (providers.some((provider) => provider.id === current))
      select.value = current;
  }

  function searchTextForOrder(order, invoice) {
    const orderItems = (order.items || []).map((item) => item.description);
    const invoiceItems = (invoice.items || []).map((item) => item.description);
    return [
      order.providerName,
      invoice.invoiceNumber,
      ...orderItems,
      ...invoiceItems,
    ]
      .filter(Boolean)
      .join(" ")
      .toLocaleLowerCase();
  }

  function renderAdmin() {
    const delivered = state.orders.filter(
      (order) => order.status === "Recibido" && getInvoiceForOrder(order.id),
    );
    renderProviderFilter(delivered);
    const total = delivered.reduce(
      (sum, order) => sum + Number(getInvoiceForOrder(order.id).total || 0),
      0,
    );
    const pending = delivered.filter(
      (order) => paymentStatus(getInvoiceForOrder(order.id)) !== "paid",
    ).length;
    const paid = delivered.filter(
      (order) => paymentStatus(getInvoiceForOrder(order.id)) === "paid",
    ).length;
    const alerts = delivered.filter((order) =>
      isPaymentAlert(getInvoiceForOrder(order.id), order),
    ).length;
    $("#admin-metrics").innerHTML = [
      metric("Entregados", delivered.length, ""),
      metric("Facturado", formatCurrency(total), "is-green"),
      metric("Pagadas", paid, "is-green"),
      metric("Alertas +7 días", alerts, alerts ? "is-red" : "is-amber"),
    ].join("");

    const query = $("#admin-search").value.trim().toLocaleLowerCase();
    const providerId = $("#admin-provider-filter").value;
    const filtered = delivered.filter((order) => {
      const invoice = getInvoiceForOrder(order.id);
      return (
        (!providerId ||
          (order.providerId || order.providerName) === providerId) &&
        (!query || searchTextForOrder(order, invoice).includes(query))
      );
    });
    $("#empty-admin").classList.toggle("hidden", delivered.length > 0);
    $("#admin-table-body").innerHTML = filtered
      .map((order) => renderAdminRow(order))
      .join("");
    if (delivered.length > 0 && !filtered.length) {
      $("#admin-table-body").innerHTML =
        '<tr><td colspan="6" class="muted">No se encontraron entregas con esos filtros.</td></tr>';
    }
    if (state.providerDialogId) renderProviderDialog(state.providerDialogId);
  }

  function metric(label, value, className) {
    return `<div class="metric"><div class="metric-label">${label}</div><p class="metric-value ${className}">${escapeHtml(value)}</p></div>`;
  }

  function renderAdminRow(order) {
    const invoice = getInvoiceForOrder(order.id);
    const status = paymentStatus(invoice);
    const paid = paidAmount(invoice);
    const hasPreview = Boolean(invoice.file?.dataUrl);
    const fileName = invoice.file?.name || "Sin archivo";
    const paymentAlert = isPaymentAlert(invoice, order);
    const ageDays = invoiceAgeDays(invoice, order);
    const orderLabel =
      order.source === "direct"
        ? "Compra directa"
        : order.id.slice(-8).toUpperCase();
    const orderMeta =
      order.source === "direct"
        ? `Factura directa · ${formatDate(order.receivedAt)}`
        : formatDate(order.receivedAt);
    return `<tr>
      <td><div class="table-primary">${escapeHtml(orderLabel)}</div><div class="table-secondary">${escapeHtml(orderMeta)}</div></td>
      <td><button class="provider-link" type="button" data-provider-id="${escapeHtml(order.providerId || order.providerName)}">${escapeHtml(order.providerName)}</button><div class="table-secondary">${(invoice.items || order.items || []).length} ítem(s)</div></td>
      <td>
        <div class="invoice-cell">
          <div class="table-primary">${escapeHtml(invoice.invoiceNumber)}</div>
          <button class="invoice-preview-button" type="button" data-preview-invoice="${escapeHtml(invoice.id)}" ${hasPreview ? "" : "disabled"}>
            <span class="eye-icon" aria-hidden="true">◉</span>${hasPreview ? "Ver comprobante" : "Sin vista previa"}
          </button>
        </div>
        <div class="table-secondary invoice-file-name" title="${escapeHtml(fileName)}">${escapeHtml(fileName)}</div>
      </td>
      <td><div class="table-primary">${formatCurrency(invoice.total)}</div><div class="table-secondary">${paid > 0 ? `${formatCurrency(paid)} abonado` : "Sin pagos"}</div></td>
      <td><div class="financial-status"><span class="status-chip status-${status}">${statusLabel(status)}</span>${paymentAlert ? `<span class="alert-badge">⚠ ${ageDays} días pendiente</span>` : ""}</div></td>
      <td><button class="table-action" type="button" data-payment-invoice="${escapeHtml(invoice.id)}"><span aria-hidden="true">＋</span> Gestionar</button></td>
    </tr>`;
  }

  function providerRecordById(providerId) {
    return (
      state.providers.find((provider) => provider.id === providerId) ||
      state.providers.find(
        (provider) =>
          provider.name.toLocaleLowerCase() ===
          normalizedName(providerId).toLocaleLowerCase(),
      ) ||
      null
    );
  }

  function providerOrders(provider) {
    return state.orders.filter(
      (order) =>
        order.providerId === provider.id ||
        order.providerName.toLocaleLowerCase() ===
          provider.name.toLocaleLowerCase(),
    );
  }

  function renderProviderDialog(providerId) {
    const provider = providerRecordById(providerId);
    if (!provider) return;
    const orders = providerOrders(provider);
    const invoices = orders
      .map((order) => getInvoiceForOrder(order.id))
      .filter(Boolean)
      .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
    const total = invoices.reduce(
      (sum, invoice) => sum + (Number(invoice.total) || 0),
      0,
    );
    const paid = invoices.reduce(
      (sum, invoice) => sum + paidAmount(invoice),
      0,
    );
    const debt = Math.max(0, total - paid);
    $("#provider-dialog-title").textContent = provider.name;
    $("#provider-dialog-meta").textContent = provider.phone
      ? `WhatsApp / teléfono: ${provider.phone}`
      : "Sin teléfono registrado";
    $("#provider-financial-summary").innerHTML = [
      metric("Facturado", formatCurrency(total), "is-green"),
      metric("Pagado", formatCurrency(paid), "is-green"),
      metric("Deuda", formatCurrency(debt), debt > 0 ? "is-red" : "is-green"),
    ].join("");
    $("#provider-invoices-list").innerHTML = invoices.length
      ? invoices
          .map((invoice) => {
            const order = getOrder(invoice.orderId);
            const status = paymentStatus(invoice);
            const alert = isPaymentAlert(invoice, order);
            return `<div class="provider-list-row">
              <div><strong>Factura ${escapeHtml(invoice.invoiceNumber)}</strong><small>${formatDate(invoice.createdAt)} · ${formatCurrency(invoice.total)}</small></div>
              <div class="provider-row-actions"><span class="status-chip status-${status}">${statusLabel(status)}</span>${alert ? `<span class="alert-badge">⚠ ${invoiceAgeDays(invoice, order)} días</span>` : ""}<button class="text-button" type="button" data-preview-invoice="${escapeHtml(invoice.id)}">Ver comprobante</button><button class="text-button" type="button" data-payment-invoice="${escapeHtml(invoice.id)}">Gestionar</button></div>
            </div>`;
          })
          .join("")
      : '<div class="provider-empty">No hay facturas registradas.</div>';
    $("#provider-orders-list").innerHTML = orders.length
      ? orders
          .slice()
          .sort(
            (a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0),
          )
          .map(
            (order) =>
              `<div class="provider-list-row"><div><strong>${order.source === "direct" ? "Compra directa" : `Pedido ${escapeHtml(order.id.slice(-8).toUpperCase())}`}</strong><small>${formatDate(order.createdAt)} · ${(order.items || []).map((item) => `${item.quantity} × ${escapeHtml(item.description)}`).join(" · ") || "Sin ítems"}</small></div><span class="status-chip ${order.status === "Recibido" ? "status-received" : "status-pending"}">${escapeHtml(order.status)}</span></div>`,
          )
          .join("")
      : '<div class="provider-empty">No hay pedidos registrados.</div>';
  }

  function openProviderDialog(providerId) {
    const provider = providerRecordById(providerId);
    if (!provider) return;
    state.providerDialogId = provider.id;
    const filter = $("#admin-provider-filter");
    if ([...filter.options].some((option) => option.value === provider.id)) {
      filter.value = provider.id;
    }
    renderProviderDialog(provider.id);
    $("#provider-dialog").showModal();
  }

  function closeProviderDialog() {
    state.providerDialogId = null;
    $("#provider-dialog").close();
  }

  function openInvoicePreview(invoiceId) {
    const invoice = getInvoice(invoiceId);
    const file = invoice?.file;
    if (!invoice || !file?.dataUrl) {
      showToast("Esta factura no tiene una vista previa guardada.");
      return;
    }
    $("#invoice-dialog-title").textContent = `Factura ${invoice.invoiceNumber}`;
    $("#invoice-dialog-meta").textContent =
      `${invoice.providerName} · ${file.name || "comprobante"} · ${formatCurrency(invoice.total)}`;
    const preview = $("#invoice-preview");
    preview.replaceChildren();
    if (
      file.type?.startsWith("image/") ||
      file.dataUrl.startsWith("data:image/")
    ) {
      const image = document.createElement("img");
      image.className = "invoice-image-preview";
      image.alt = `Factura ${invoice.invoiceNumber}`;
      image.src = file.dataUrl;
      preview.append(image);
    } else if (
      file.type === "application/pdf" ||
      file.dataUrl.startsWith("data:application/pdf")
    ) {
      const frame = document.createElement("iframe");
      frame.className = "invoice-pdf-preview";
      frame.title = `Factura ${invoice.invoiceNumber}`;
      frame.src = file.dataUrl;
      preview.append(frame);
    } else {
      const link = document.createElement("a");
      link.className = "primary-button invoice-download-link";
      link.href = file.dataUrl;
      link.download = file.name || `factura-${invoice.invoiceNumber}`;
      link.textContent = "Descargar comprobante";
      preview.append(link);
    }
    $("#invoice-dialog").showModal();
  }

  function closeInvoicePreview() {
    $("#invoice-dialog").close();
    $("#invoice-preview").replaceChildren();
  }

  function renderPaymentHistory(invoice) {
    const payments = invoice.payments || [];
    $("#payment-history").innerHTML = payments.length
      ? `<div class="payment-history-title">Pagos registrados</div>${payments
          .slice()
          .reverse()
          .map(
            (payment) =>
              `<div class="payment-history-row"><span>${formatDate(payment.date)}${payment.note ? ` · ${escapeHtml(payment.note)}` : ""}</span><strong>${formatCurrency(payment.amount)}</strong></div>`,
          )
          .join("")}`
      : '<div class="payment-history-empty">Todavía no hay pagos registrados.</div>';
  }

  function updatePaymentProgress(invoice) {
    const total = Number(invoice.total) || 0;
    const paid = paidAmount(invoice);
    const percentage = total > 0 ? Math.min(100, (paid / total) * 100) : 0;
    $("#payment-progress-bar").style.width = `${percentage}%`;
    renderPaymentHistory(invoice);
  }

  function openPaymentDialog(invoiceId) {
    const invoice = getInvoice(invoiceId);
    if (!invoice) return;
    state.paymentInvoiceId = invoiceId;
    const paid = paidAmount(invoice);
    const balance = Math.max(0, Number(invoice.total) - paid);
    $("#payment-dialog-title").textContent =
      `Pagar factura ${invoice.invoiceNumber}`;
    $("#payment-summary").innerHTML =
      `<strong>${escapeHtml(invoice.providerName)}</strong><br>Total: ${formatCurrency(invoice.total)} · Abonado: ${formatCurrency(paid)} · Saldo: ${formatCurrency(balance)}`;
    updatePaymentProgress(invoice);
    $("#payment-amount").value = "";
    $("#payment-note").value = "";
    $("#payment-message").textContent = "";
    $("#payment-message").classList.remove("is-error");
    const status = paymentStatus(invoice);
    const cashOption = $('input[name="payment-mode"][value="cash"]');
    const accountOption = $('input[name="payment-mode"][value="account"]');
    cashOption.checked = status === "paid" && invoice.paymentMode === "cash";
    accountOption.checked = !cashOption.checked;
    togglePartialFields();
    $("#payment-dialog").showModal();
  }

  function togglePartialFields() {
    const account = $('input[name="payment-mode"][value="account"]').checked;
    $("#partial-payment-fields").classList.toggle("hidden", !account);
    if (account && state.paymentInvoiceId) {
      const invoice = getInvoice(state.paymentInvoiceId);
      const balance = Math.max(
        0,
        Number(invoice?.total || 0) - paidAmount(invoice),
      );
      $("#payment-balance").textContent =
        `Saldo actual: ${formatCurrency(balance)}. Dejá vacío para solo marcar cuenta corriente.`;
    }
  }

  function savePayment(event) {
    event.preventDefault();
    const invoice = getInvoice(state.paymentInvoiceId);
    const message = $("#payment-message");
    message.classList.remove("is-error");
    if (!invoice) return;
    const mode = $('input[name="payment-mode"]:checked').value;
    const balance = Math.max(0, Number(invoice.total) - paidAmount(invoice));
    const note = normalizedName($("#payment-note").value);
    invoice.paymentMode = mode;
    if (mode === "cash") {
      invoice.payments = [
        {
          id: id("pay"),
          amount: Number(invoice.total),
          date: now(),
          note,
          mode: "cash",
        },
      ];
    } else {
      const rawAmount = $("#payment-amount").value.trim();
      if (rawAmount) {
        const amount = parseMoney(rawAmount);
        if (amount <= 0 || amount > balance + 0.01) {
          message.textContent = `El importe debe ser mayor a cero y no superar ${formatCurrency(balance)}.`;
          message.classList.add("is-error");
          return;
        }
        invoice.payments = [
          ...(invoice.payments || []),
          { id: id("pay"), amount, date: now(), note, mode: "account" },
        ];
      }
    }
    saveCollections();
    $("#payment-dialog").close();
    renderAdmin();
    showToast(
      paymentStatus(invoice) === "paid"
        ? "Factura marcada como pagada"
        : "Pago guardado",
    );
  }

  function exportData() {
    const payload = {
      Proveedores: state.providers,
      Pedidos: state.orders,
      Facturas_Y_Pagos: state.invoices,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `deposito-export-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(link.href);
  }

  let toastTimer;
  function showToast(message) {
    const toast = $("#toast");
    toast.textContent = message;
    toast.classList.add("is-visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("is-visible"), 3200);
  }

  function switchView(viewId) {
    $$(".tab-button").forEach((button) =>
      button.classList.toggle("is-active", button.dataset.view === viewId),
    );
    $$(".view").forEach((view) =>
      view.classList.toggle("is-active", view.id === viewId),
    );
    if (viewId === "admin-view") renderAdmin();
  }

  $("#order-form").addEventListener("submit", createOrder);
  $("#order-supplier").addEventListener("input", prefillProviderPhone);
  $("#order-supplier").addEventListener("change", prefillProviderPhone);
  $("#add-item-button").addEventListener("click", () => {
    state.itemRows = [
      ...readRenderedItemRows($("#order-items")),
      { description: "", quantity: 1 },
    ];
    renderItemRows($("#order-items"), state.itemRows);
  });
  $("#order-items").addEventListener("click", (event) => {
    const button = event.target.closest("[data-remove-item]");
    if (!button) return;
    const rows = readRenderedItemRows($("#order-items"));
    rows.splice(Number(button.dataset.removeItem), 1);
    state.itemRows = rows;
    renderItemRows($("#order-items"), state.itemRows);
  });
  $("#pending-orders").addEventListener("change", (event) => {
    if (event.target.matches("[data-invoice-file]")) {
      selectFile(
        event.target.closest("[data-order-id]").dataset.orderId,
        event.target.files[0],
      );
    }
  });
  $("#pending-orders").addEventListener("click", async (event) => {
    const action = event.target.closest("[data-action]")?.dataset.action;
    const card = event.target.closest("[data-order-id]");
    if (!card || !action) return;
    const orderId = card.dataset.orderId;
    if (action === "ocr") await processOcr(orderId, card);
    if (action === "manual") {
      const draft =
        state.receptionDrafts.get(orderId) || createDraft(getOrder(orderId));
      draft.error = "";
      state.receptionDrafts.set(orderId, draft);
      renderWarehouse();
    }
    if (action === "add-receiving-item") {
      const draft = state.receptionDrafts.get(orderId);
      syncDraftFromForm(card, draft);
      draft.items.push({ description: "", quantity: 1 });
      state.receptionDrafts.set(orderId, draft);
      renderWarehouse();
    }
  });
  $("#pending-orders").addEventListener("click", (event) => {
    const button = event.target.closest("[data-remove-receiving-item]");
    const card = event.target.closest("[data-order-id]");
    if (!button || !card) return;
    const draft = state.receptionDrafts.get(card.dataset.orderId);
    syncDraftFromForm(card, draft);
    draft.items.splice(Number(button.dataset.removeReceivingItem), 1);
    if (!draft.items.length) draft.items.push({ description: "", quantity: 1 });
    state.receptionDrafts.set(card.dataset.orderId, draft);
    renderWarehouse();
  });
  $("#pending-orders").addEventListener("submit", (event) => {
    const form = event.target.closest("[data-receiving-form]");
    if (form)
      confirmReception(
        event,
        form.closest("[data-order-id]").dataset.orderId,
        form.closest("[data-order-id]"),
      );
  });
  $("#quick-purchase-button").addEventListener("click", openDirectPurchase);
  $("#close-quick-purchase-button").addEventListener(
    "click",
    closeDirectPurchase,
  );
  $("#direct-invoice-file").addEventListener("change", (event) => {
    const draft = state.directPurchaseDraft || createDirectDraft();
    const file = event.target.files?.[0];
    draft.fileObject = file || null;
    draft.file = file
      ? { name: file.name, type: file.type, size: file.size }
      : null;
    draft.formVisible = Boolean(file);
    draft.error = "";
    state.directPurchaseDraft = draft;
    renderDirectPurchase();
  });
  $("#direct-provider-hint").addEventListener("input", (event) => {
    const draft = state.directPurchaseDraft || createDirectDraft();
    draft.providerName = normalizedName(event.target.value);
    applyProviderMemoryToDraft(draft, findProviderByName(draft.providerName));
    state.directPurchaseDraft = draft;
  });
  $("#direct-ocr-button").addEventListener("click", processDirectOcr);
  $("#direct-manual-button").addEventListener("click", () => {
    const draft = state.directPurchaseDraft || createDirectDraft();
    draft.formVisible = true;
    draft.error = "";
    state.directPurchaseDraft = draft;
    renderDirectPurchase();
  });
  $("#quick-purchase-card").addEventListener("click", (event) => {
    const card = event.currentTarget;
    const action = event.target.closest("[data-action]")?.dataset.action;
    if (action === "add-receiving-item") {
      const draft = state.directPurchaseDraft;
      syncDraftFromForm(card, draft);
      draft.items.push({ description: "", quantity: 1 });
      state.directPurchaseDraft = draft;
      renderDirectPurchase();
      return;
    }
    const removeButton = event.target.closest("[data-remove-receiving-item]");
    if (removeButton) {
      const draft = state.directPurchaseDraft;
      syncDraftFromForm(card, draft);
      draft.items.splice(Number(removeButton.dataset.removeReceivingItem), 1);
      if (!draft.items.length)
        draft.items.push({ description: "", quantity: 1 });
      state.directPurchaseDraft = draft;
      renderDirectPurchase();
    }
  });
  $("#quick-purchase-card").addEventListener("submit", (event) => {
    const form = event.target.closest("[data-direct-receiving-form]");
    if (form) confirmDirectPurchase(event, form);
  });
  $$(".tab-button").forEach((button) =>
    button.addEventListener("click", () => switchView(button.dataset.view)),
  );
  $("#admin-search").addEventListener("input", renderAdmin);
  $("#admin-provider-filter").addEventListener("change", (event) => {
    if (event.target.value) openProviderDialog(event.target.value);
    else if (state.providerDialogId) closeProviderDialog();
    renderAdmin();
  });
  $("#admin-table-body").addEventListener("click", (event) => {
    const providerId =
      event.target.closest("[data-provider-id]")?.dataset.providerId;
    if (providerId) {
      openProviderDialog(providerId);
      return;
    }
    const previewId = event.target.closest("[data-preview-invoice]")?.dataset
      .previewInvoice;
    if (previewId) {
      openInvoicePreview(previewId);
      return;
    }
    const invoiceId = event.target.closest("[data-payment-invoice]")?.dataset
      .paymentInvoice;
    if (invoiceId) openPaymentDialog(invoiceId);
  });
  $("#provider-dialog").addEventListener("click", (event) => {
    const previewId = event.target.closest("[data-preview-invoice]")?.dataset
      .previewInvoice;
    if (previewId) {
      openInvoicePreview(previewId);
      return;
    }
    const invoiceId = event.target.closest("[data-payment-invoice]")?.dataset
      .paymentInvoice;
    if (invoiceId) openPaymentDialog(invoiceId);
  });
  $("#payment-form").addEventListener("submit", savePayment);
  $("#payment-form").addEventListener("click", (event) => {
    const shortcut = event.target.closest("[data-payment-shortcut]")?.dataset
      .paymentShortcut;
    if (!shortcut || !state.paymentInvoiceId) return;
    const invoice = getInvoice(state.paymentInvoiceId);
    const balance = Math.max(
      0,
      Number(invoice?.total || 0) - paidAmount(invoice),
    );
    if (shortcut === "balance") $("#payment-amount").value = balance.toFixed(2);
    if (shortcut === "clear") $("#payment-amount").value = "";
  });
  $("#payment-form").addEventListener("change", (event) => {
    if (event.target.name === "payment-mode") togglePartialFields();
  });
  $("#close-dialog-button").addEventListener("click", () =>
    $("#payment-dialog").close(),
  );
  $("#cancel-dialog-button").addEventListener("click", () =>
    $("#payment-dialog").close(),
  );
  $("#close-provider-button").addEventListener("click", closeProviderDialog);
  $("#cancel-provider-button").addEventListener("click", closeProviderDialog);
  $("#provider-dialog").addEventListener("close", () => {
    state.providerDialogId = null;
  });
  $("#close-invoice-button").addEventListener("click", closeInvoicePreview);
  $("#cancel-invoice-button").addEventListener("click", closeInvoicePreview);
  $("#invoice-dialog").addEventListener("close", () =>
    $("#invoice-preview").replaceChildren(),
  );
  $("#export-button").addEventListener("click", exportData);

  renderItemRows($("#order-items"), state.itemRows);
  renderWarehouse();
  renderAdmin();
})();

const SOAP = 'http://schemas.xmlsoap.org/soap/envelope/';
const XSI = 'http://www.w3.org/2001/XMLSchema-instance';
const variable = /^[A-Za-z_][A-Za-z0-9_]*$/;
const idPattern = /^\d{1,30}$/;
export const soapActions = Object.freeze({
  update: 'updateTransaction',
  get: 'getTransaction'
});

export function escapeXml(value) {
  return String(value).replace(/[&<>"'\r]/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;', '\r': '&#13;'
  })[c]);
}

export function siteOrigin(value) {
  let site;
  try { site = new URL(value.trim()); } catch { throw new Error('Enter the full CPQ site URL.'); }
  if (site.protocol !== 'https:' || site.port || site.username || site.password ||
      !/\.(bigmachines\.com|oracle\.com|oraclecloud\.com)$/.test(site.hostname) ||
      site.pathname !== '/' || site.search || site.hash) {
    throw new Error('Enter only the HTTPS origin of your Oracle CPQ site.');
  }
  return site.origin;
}

export function validate(config) {
  const origin = siteOrigin(config.site);
  for (const key of ['process', 'document', 'action', 'requestToggle', 'responseToggle']) {
    if (!variable.test(config[key])) throw new Error('Check the variable names in Commerce settings.');
  }
  if (!idPattern.test(config.bsId)) throw new Error('Enter a numeric BS Id.');
  if (config.baseline === config.comparison) throw new Error('Choose two different pricing scenarios.');
  if (!['Old Pricing', 'New Pricing'].includes(config.baseline) ||
      !['Old Pricing', 'New Pricing'].includes(config.comparison)) throw new Error('Invalid pricing scenario.');
  if (!config.username.trim() || !config.password) throw new Error('Enter your CPQ credentials.');
  return origin;
}

async function request(url, options, label, transport) {
  let response;
  try {
    response = await transport(url, {
      ...options, redirect: 'error', credentials: 'omit', cache: 'no-store',
      signal: AbortSignal.timeout(300_000)
    });
  } catch (error) {
    const cause = error.name === 'TimeoutError' ? 'timed out' : 'could not connect';
    throw new Error(label + ' ' + cause + '. ' + (error.message || 'Check the site URL and access.'));
  }
  return response;
}

export function soapPayload(config, id, mode, update) {
  const cpq = 'http://xmlns.oracle.com/cpqcloud/commerce/' + config.process;
  const operation = update ? soapActions.update : soapActions.get;
  const username = escapeXml(config.username);
  const password = escapeXml(config.password);
  const transaction = escapeXml(id);
  const body = update ? `
      <bm:process_var_name>${config.process}</bm:process_var_name>
      <bm:data_xml>
        <bm:${config.document} bm:bs_id="${transaction}" bm:data_type="0" bm:document_number="1" bm:document_var_name="${config.document}" bm:process_var_name="${config.process}">
          <bm:${config.requestToggle}>${escapeXml(mode)}</bm:${config.requestToggle}>
        </bm:${config.document}>
      </bm:data_xml>
      <bm:action_data>
        <bm:action_var_name>${config.action}</bm:action_var_name>
      </bm:action_data>` : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="${SOAP}" xmlns:bm="${cpq}"
    xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd">
  <soap:Header><wsse:Security><wsse:UsernameToken>
    <wsse:Username>${username}</wsse:Username>
    <wsse:Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordText">${password}</wsse:Password>
  </wsse:UsernameToken></wsse:Security></soap:Header>
  <soap:Body><bm:${operation}><bm:transaction><bm:id>${transaction}</bm:id>${body}
  </bm:transaction></bm:${operation}></soap:Body>
</soap:Envelope>`;
}

function parseXml(raw) {
  if (/<!DOCTYPE|<!ENTITY/i.test(raw)) throw new Error('CPQ returned unsupported XML declarations.');
  const root = new DOMParser().parseFromString(raw, 'application/xml').documentElement;
  if (root.localName === 'parsererror') throw new Error('CPQ returned invalid XML.');
  return root;
}

const child = (root, name) => Array.from(root?.children ?? []).find(node => node.localName === name);

export function soapFaultMessage(raw) {
  try {
    const root = parseXml(raw);
    const fault = root.localName === 'Fault' ? root :
      Array.from(root.getElementsByTagNameNS('*', 'Fault')).find(node =>
        node.namespaceURI === SOAP || node.namespaceURI === 'http://www.w3.org/2003/05/soap-envelope');
    if (!fault) return '';
    for (const name of ['faultstring', 'Text', 'exceptionMessage']) {
      const message = Array.from(fault.getElementsByTagNameNS('*', name))
        .map(node => node.textContent.trim()).filter(Boolean).join('\n');
      if (message) return message;
    }
    return fault.textContent.trim() || 'SOAP Fault returned without a message.';
  } catch {
    return '';
  }
}

function safeResponseMessage(message, config) {
  for (const value of [config.password, config.username]) {
    if (value) {
      message = message.split(escapeXml(value)).join('[redacted]');
      message = message.split(value).join('[redacted]');
    }
  }
  return message.length > 8000 ? message.slice(0, 8000) + '\n[Message shortened]' : message;
}

export function checkSoapResponse(raw, status, label, config) {
  const fault = soapFaultMessage(raw);
  if (fault) {
    throw new Error(label + ' — HTTP ' + status + '\n' + safeResponseMessage(fault, config));
  }
  if (status !== 200) {
    // Treat any returned body as text. It is never inserted as HTML.
    let detail = '';
    if (raw.trim()) {
      const root = new DOMParser().parseFromString(raw, 'text/html');
      detail = (root.body?.textContent || raw).trim();
    }
    const message = detail ? safeResponseMessage(detail, config) :
      'The server returned no response body.';
    throw new Error(label + ' — HTTP ' + status + '\n' + message);
  }
}

export function readSnapshot(raw, config, required = true) {
  const root = parseXml(raw);
  const body = root.namespaceURI === SOAP ? child(root, 'Body') : null;
  const payload = body ? body.firstElementChild : root;
  if (!payload || payload.localName === 'Fault' || child(payload, 'Fault')) {
    throw new Error(soapFaultMessage(raw) || 'CPQ returned an empty SOAP response.');
  }
  const status = child(payload, 'status');
  const success = child(status, 'success') ?? child(payload, 'success') ??
    Array.from(payload.getElementsByTagNameNS('*', 'success')).find(element => element.parentElement?.localName === 'status');
  if (success && !['true', '1'].includes(success.textContent.trim().toLowerCase())) {
    const message = child(status, 'message') ?? child(payload, 'message');
    throw new Error('CPQ rejected the SOAP operation.' + (message?.textContent.trim() ? '\n' + message.textContent.trim() : ''));
  }
  const sections = payload.localName === 'data_xml' ? [payload] :
    Array.from(payload.getElementsByTagNameNS('*', 'data_xml'));
  if (sections.length > 1) throw new Error('CPQ returned multiple transaction snapshots.');
  const section = sections[0];
  const header = section?.firstElementChild ??
    (section?.textContent.trim() ? parseXml(section.textContent.trim()) : null);
  const toggle = child(header, config.responseToggle)?.textContent.trim();
  if (!header || !toggle) {
    if (!required) return null;
    throw new Error('The XML snapshot is missing the transaction or the configured pricing toggle.');
  }
  const skip = new Set([config.requestToggle, config.responseToggle, 'pricingToggle_t',
    'pricingToggle_t_c', 'obsolete_attributes', 'createdDate_t', 'lastUpdatedDate_t',
    'lastPricedDate_t', ...config.exclude.split(',').map(name => name.trim())]);
  const documentNumbers = new Set();
  const values = new Map();
  const serializer = new XMLSerializer();

  function scan(document) {
    const number = (Array.from(document.attributes).find(a => a.localName === 'document_number')?.value ??
      child(document, '_document_number')?.textContent ?? '').trim();
    if (!number || documentNumbers.has(number)) {
      throw new Error('The XML contains a missing or duplicate document number.');
    }
    documentNumbers.add(number);
    for (const field of document.children) {
      const attribute = field.localName;
      if (attribute === 'sub_documents') {
        for (const line of field.children) scan(line);
      } else if (!attribute.startsWith('_') && !skip.has(attribute)) {
        const key = JSON.stringify([number, attribute]);
        if (values.has(key)) throw new Error('The XML contains a repeated attribute on document ' + number + '.');
        const nil = ['true', '1'].includes(field.getAttributeNS(XSI, 'nil'));
        values.set(key, {
          number, attribute, nil,
          text: nil ? '' : field.childElementCount ? serializer.serializeToString(field) : field.textContent
        });
      }
    }
  }
  scan(header);
  if (values.size === 0) {
    if (!required) return null;
    throw new Error('The snapshot contains no comparable attributes.');
  }
  return {toggle, values};
}

export async function runPricing(origin, config, id, mode, onUpdate, transport = fetch) {
  const url = new URL('/v2_0/receiver/commerce/' + config.process, origin);
  const call = async update => {
    const label = update ? soapActions.update : soapActions.get;
    const response = await request(url, {
      method: 'POST',
      headers: {'Content-Type': 'text/xml; charset=utf-8', SOAPAction: label},
      body: soapPayload(config, id, mode, update)
    }, label, transport);
    const raw = await response.text();
    checkSoapResponse(raw, response.status, label, config);
    return raw;
  };
  onUpdate(mode + ': running updateTransaction…');
  const update = await call(true);
  let snapshot = readSnapshot(update, config, false);
  if (config.alwaysGet || !snapshot) {
    onUpdate(mode + ': reading transaction XML…');
    snapshot = readSnapshot(await call(false), config);
  }
  if (snapshot.toggle !== mode) {
    throw new Error('CPQ returned an unexpected pricing toggle after ' + mode + '. Check the action and field names.');
  }
  return snapshot;
}

export function compareSnapshots(oldSnapshot, newSnapshot) {
  const keys = new Set([...oldSnapshot.values.keys(), ...newSnapshot.values.keys()]);
  const display = field => !field ? '[Missing]' : field.nil ? '[Null]' : field.text;
  let failed = 0;
  const rows = [['Doc Number', 'Attribute Name', 'Old Pricing Value', 'New Pricing Value', 'Status']];
  for (const key of keys) {
    const oldField = oldSnapshot.values.get(key);
    const newField = newSnapshot.values.get(key);
    const field = oldField ?? newField;
    const passed = oldField && newField && oldField.nil === newField.nil && oldField.text === newField.text;
    if (!passed) failed++;
    rows.push([field.number, field.attribute, display(oldField), display(newField), passed ? 'Passed' : 'Failed']);
  }
  return {rows, failed};
}

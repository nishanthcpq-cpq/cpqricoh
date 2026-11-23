import {cpqTabTransport} from './tab-transport.js';
import {siteOrigin, validate, soapActions, runPricing, compareSnapshots} from './cpq.js';
import {makeWorkbook} from './xlsx.js';

const form = document.querySelector('#compare-form');
const compareButton = document.querySelector('#compare');
const status = document.querySelector('#status');
const savedSite = document.querySelector('#saved-site');
const saveSite = document.querySelector('#save-site');
const preferences = ['site', 'username', 'password', 'process', 'document', 'action',
  'requestToggle', 'responseToggle', 'exclude', 'alwaysGet', 'requestContext'];

function setStatus(message, isError = false) {
  status.hidden = false;
  status.classList.toggle('error', isError);
  status.textContent = message;
}

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.download = filename;
  link.href = url;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

const defaults = Object.fromEntries(preferences.map(key => {
  const field = form.elements.namedItem(key);
  return [key, field.type === 'checkbox' ? field.defaultChecked : (field.defaultValue ?? field.value)];
}));
let profiles = [];

function showSites(selected = '') {
  savedSite.replaceChildren(new Option('New site', ''));
  for (const profile of profiles) {
    savedSite.add(new Option(new URL(profile.site).hostname, profile.site));
  }
  savedSite.value = selected;
}

function currentAction(value) {
  const action = typeof value === 'string' ? value.trim() : '';
  return !action || action.toLowerCase() === 'cleansave_t'
    ? 'oRCL_OSC_UpdateOpportunity' : action;
}

function useProfile(profile = {}) {
  profile = {...profile, action: currentAction(profile.action)};
  for (const key of preferences) {
    const field = form.elements.namedItem(key);
    if (field.type === 'checkbox') field.checked = profile[key] ?? defaults[key];
    else field.value = profile[key] ?? defaults[key];
  }
}

savedSite.disabled = true;
saveSite.disabled = true;
chrome.storage.local.get(['siteProfiles', 'lastSite', 'preferences']).then(async saved => {
  if (Array.isArray(saved.siteProfiles)) {
    profiles = saved.siteProfiles;
  } else if (saved.preferences?.site) {
    profiles = [{...saved.preferences, site: siteOrigin(saved.preferences.site)}];
  }
  profiles = profiles.map(profile => ({
    ...profile,
    action: currentAction(profile.action)
  }));
  const selected = saved.lastSite === '' ? undefined :
    profiles.find(profile => profile.site === saved.lastSite) ?? profiles[0];
  showSites(selected?.site);
  if (selected && !form.elements.namedItem('site').value) useProfile(selected);
  const actionField = form.elements.namedItem('action');
  actionField.value = currentAction(actionField.value);
  await chrome.storage.local.set({siteProfiles: profiles});
}).catch(() => {
  setStatus('Saved site settings could not be read.', true);
}).finally(() => {
  savedSite.disabled = false;
  saveSite.disabled = false;
});

savedSite.addEventListener('change', () => {
  useProfile(profiles.find(profile => profile.site === savedSite.value));
  status.hidden = true;
  chrome.storage.local.set({lastSite: savedSite.value}).catch(() => {});
});

saveSite.addEventListener('click', async () => {
  saveSite.disabled = true;
  compareButton.disabled = true;
  savedSite.disabled = true;
  try {
    const details = Object.fromEntries(preferences.map(key => {
      const field = form.elements.namedItem(key);
      return [key, field.type === 'checkbox' ? field.checked : key === 'password' ? field.value : field.value.trim()];
    }));
    details.site = siteOrigin(details.site);
    const updated = [details, ...profiles.filter(profile => profile.site !== details.site)]
      .sort((a, b) => a.site.localeCompare(b.site));
    await chrome.storage.local.set({siteProfiles: updated, lastSite: details.site});
    profiles = updated;
    showSites(details.site);
    setStatus('Site settings saved for ' + new URL(details.site).hostname + '.');
  } catch (error) {
    setStatus('Could not save site settings. ' + error.message, true);
  } finally {
    saveSite.disabled = false;
    compareButton.disabled = false;
    savedSite.disabled = false;
  }
});

form.elements.namedItem('updateSoapAction').value = soapActions.update;
form.elements.namedItem('getSoapAction').value = soapActions.get;

form.addEventListener('submit', async event => {
  event.preventDefault();
  if (compareButton.disabled) return;
  const config = Object.fromEntries(new FormData(form));
  config.alwaysGet = Boolean(config.alwaysGet);
  config.bsId = config.bsId.trim();
  config.username = config.username.trim();
  config.action = currentAction(config.action);
  form.elements.namedItem('action').value = config.action;
  let started = false;
  const controls = Array.from(form.elements).filter(element => !element.disabled);
  try {
    const origin = validate(config);
    // Request the exact origin directly from the Compare click.
    const allowed = await (() => {
      controls.forEach(element => { element.disabled = true; });
      setStatus('Checking access to the selected CPQ site…');
      return chrome.permissions.request({origins: [origin + '/*']});
    })();
    if (!allowed) throw new Error('Allow access to the selected CPQ site to run the comparison.');
    const transport = config.requestContext === 'extension'
      ? fetch : await cpqTabTransport(origin);
    started = true;
    const snapshots = new Map();
    for (const mode of [config.baseline, config.comparison]) {
      snapshots.set(mode, await runPricing(origin, config, config.bsId, mode, setStatus, transport));
    }
    const {rows, failed} = compareSnapshots(snapshots.get('Old Pricing'), snapshots.get('New Pricing'));
    const filename = 'CPQ-Pricing-' + config.bsId + '.xlsx';
    started = false;
    download(makeWorkbook(rows), filename);
    setStatus(`Excel download started. ${rows.length - 1 - failed} passed and ${failed} failed. The quote is in ${config.comparison}.`);
  } catch (error) {
    const detail = started ? ' Check the quote’s current pricing state before retrying.' : '';
    setStatus(error.message + detail, true);
  } finally {
    controls.forEach(element => { element.disabled = false; });
  }
});

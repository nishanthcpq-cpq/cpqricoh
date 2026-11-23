// Runs each SOAP call in the selected CPQ site's main browser context.
async function fetchInCpqTab(expectedOrigin, path, request) {
  if (location.origin !== expectedOrigin) {
    return {error: 'The CPQ tab moved to a different site. Open the selected CPQ site again.'};
  }
  const url = new URL(path, location.origin);
  if (url.origin !== expectedOrigin || !url.pathname.startsWith('/v2_0/receiver/commerce/')) {
    return {error: 'Unexpected CPQ request destination.'};
  }
  try {
    const response = await fetch(url.href, {
      method: 'POST', headers: request.headers, body: request.body,
      credentials: 'same-origin', mode: 'same-origin', redirect: 'error',
      cache: 'no-store', signal: AbortSignal.timeout(300_000)
    });
    return {status: response.status, body: await response.text()};
  } catch (error) {
    return {error: error.name === 'TimeoutError'
      ? 'The CPQ tab request timed out. Check the quote state before retrying.'
      : 'The request from the CPQ tab failed. Check that the tab is still open and signed in.'};
  }
}

export async function cpqTabTransport(origin) {
  const tabs = await chrome.tabs.query({url: origin + '/*'});
  const tab = tabs.filter(item => Number.isInteger(item.id))
    .sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))[0];
  if (!tab) {
    throw new Error('Open ' + origin + ' in another tab and sign in, then click Compare again.');
  }
  return async (url, options) => {
    if (new URL(url).origin !== origin) throw new Error('Unexpected CPQ request destination.');
    let results;
    try {
      results = await chrome.scripting.executeScript({
        target: {tabId: tab.id}, world: 'MAIN', func: fetchInCpqTab,
        args: [origin, new URL(url).pathname, {headers: options.headers, body: options.body}]
      });
    } catch {
      throw new Error('Could not access the CPQ tab. Reload the extension, allow site access, and keep the signed-in CPQ tab open.');
    }
    const result = results[0]?.result;
    if (!result || result.error) throw new Error(result?.error || 'The CPQ tab returned no result.');
    return new Response(result.body, {status: result.status});
  };
}

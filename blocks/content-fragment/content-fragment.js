import { getMetadata } from '../../scripts/aem.js';
import { isAuthorEnvironment } from '../../scripts/scripts.js';

/**
 *
 * @param {Element} block
 */
export default async function decorate(block) {
  const CONFIG = {
    WRAPPER_SERVICE_URL: 'https://prod-60.eastus2.logic.azure.com:443/workflows/94ef4cd1fc1243e08aeab8ae74bc7980/triggers/manual/paths/invoke',
    WRAPPER_SERVICE_PARAMS: 'api-version=2016-10-01&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=e81iCCcESEf9NzzxLvbfMGPmredbADtTZSs8mspUTa4',
    GRAPHQL_QUERY: '/graphql/execute.json/wknd-universal/CTAByPath'
  };
	
	const hostname = getMetadata('hostname');	
  const aemauthorurl = getMetadata('authorurl') || '';

  const aempublishurl = hostname?.replace('author', 'publish')?.replace(/\/$/, '');  
	
  const contentPath = block.querySelector(':scope div:nth-child(1) > div a')?.textContent?.trim();
	
	let variationname = "";
	const variation = block.querySelector(':scope div:nth-child(2) > div')?.textContent?.trim() || '';
	console.log('[content-fragment] variation from nth-child(2):', variation);
	const displayStyle = block.querySelector(':scope div:nth-child(3) > div')?.textContent?.trim() || '';
	const alignment = block.querySelector(':scope div:nth-child(4) > div')?.textContent?.trim() || '';
	const ctaStyle = block.querySelector(':scope div:nth-child(5) > div')?.textContent?.trim() || 'button';

  // Do not clear immediately; preserve current child structure until new markup is ready

  const isAuthor = isAuthorEnvironment();
  console.log('[content-fragment] init:', { isAuthor, contentPath });

	// Persist/read helpers for variation
	const persistVariationToDom = (next) => {
		try {
			if (!next) return;
			const col = block.querySelector(':scope div:nth-child(2) > div');
			if (col) {
				if (col.textContent !== next) col.textContent = next;
				// In author, bind the second column to UE so this value persists to JCR
				if (isAuthor) {
					if (col.getAttribute('data-aue-prop') !== 'variation') col.setAttribute('data-aue-prop', 'variation');
					if (col.getAttribute('data-aue-type') !== 'text') col.setAttribute('data-aue-type', 'text');
					if (!col.getAttribute('data-aue-label')) col.setAttribute('data-aue-label', 'Selected Variation');
				}
			}
		} catch (_) { /* ignore */ }
	};
	const readVariationFromPublishedDom = () => {
		try {
			const col = block.querySelector(':scope div:nth-child(2) > div');
			const txt = col && col.textContent && col.textContent.trim();
			if (txt) return txt.toLowerCase().replace(' ', '_');
			return '';
		} catch (_) { return ''; }
	};

	// Log authored block resource (if present) right at load
	try {
		const authoredResource = block.dataset && (block.dataset.aueResource || block.dataset["aueResource"]) || '';
		if (authoredResource) {
			console.log('[content-fragment] authored block resource:', authoredResource);
		}
	} catch (_) { /* ignore */ }

	// Dedup/race-safety for GraphQL fetches
	let __cfRequestId = 0;
  let __cfAbort = null;

	// Ensure UE connection once (provides token/org/authorUrl for subsequent JSON fetches)
	const ensureUeConnection = async () => {
		if (!isAuthor || block.__cfUeConnInit) return;
		block.__cfUeConnInit = true;
		const attachWithRetry = async () => {
			for (let i = 0; i < 5; i += 1) {
				try {
					const attach = window.adobe?.uix?.guest?.attach;
					if (typeof attach !== 'function') { await new Promise((r) => setTimeout(r, 400)); continue; }
					const conn = await attach({ id: 'wknd-content-fragment' });
					return conn || null;
				} catch (_) { await new Promise((r) => setTimeout(r, 400)); }
			}
			return null;
		};
		try {
			const conn = await attachWithRetry();
			if (!conn) return;
			block.__cfUE = { conn };
			const token = conn?.sharedContext?.get?.('token');
			const scOrgId = conn?.sharedContext?.get?.('orgId');
			if (typeof token === 'string' && token) console.log('[content-fragment] token present'); else console.warn('[content-fragment] token missing');
			let authorResolved = '';
			try {
				const initialState = await conn.host?.editorState?.get?.();
				const connections = initialState?.connections || {};
				if (connections && typeof connections === 'object') {
					const values = Object.values(connections);
					const strVal = values.find((val) => typeof val === 'string');
					if (typeof strVal === 'string') authorResolved = strVal;
					if (!authorResolved) {
						const objVal = values.find((val) => val && typeof val === 'object' && typeof val.url === 'string');
						if (objVal) authorResolved = objVal.url;
					}
				}
				if (authorResolved) authorResolved = authorResolved.replace(/^(aem:|xwalk:)/, '');
			} catch (_) { /* ignore */ }
			console.log('[content-fragment] UE host details:', { authorUrl: authorResolved, orgId: scOrgId, tokenPresent: !!token });
			let apiKey = '';
			try { apiKey = window.localStorage.getItem('aemApiKey') || ''; } catch (_) { /* ignore */ }
			block.__cfAuth = { token: typeof token === 'string' ? token : '', orgId: typeof scOrgId === 'string' ? scOrgId : '', apiKey, authorUrl: authorResolved || aemauthorurl || window.location.origin };
		} catch (_) { /* ignore */ }
	};

	const pickVariation = (node) => {
		try {
			if (!node || typeof node !== 'object') return undefined;
			if (node.model === 'contentfragment' && typeof node.contentFragmentVariation === 'string') {
				return node.contentFragmentVariation;
			} else {
        return "master";
      }
		} catch (_) { return "master"; }
	};

	const fetchCfRootModelJson = async (selectedPath) => {
		try {
			const auth = block.__cfAuth || {};
			const authorBase = auth.authorUrl || aemauthorurl || window.location.origin;
			const url = `${authorBase}${selectedPath}.json`;
			const headers = { 'Accept': 'application/json' };
			if (auth.token) headers['Authorization'] = `Bearer ${auth.token}`;
			if (auth.orgId) headers['x-gw-ims-org-id'] = auth.orgId;
			if (auth.apiKey) headers['x-api-key'] = auth.apiKey;
			const res = await fetch(url, { method: 'GET', headers, credentials: 'include', mode: 'cors' });
			if (!res.ok) return { url, error: res.status };
			const json = await res.json();
			return { url, json };
		} catch (_) { return null; }
	};

  const fetchAndRender = async (variationToUse) => {
		const v = (variationToUse || 'master');
		if (block.__cfRenderedFor === v) {
			console.log('[content-fragment] skip GraphQL (unchanged variation):', v);
			return;
		}
		if (__cfAbort) { try { __cfAbort.abort(); } catch (_) {} }
		const controller = new AbortController();
		__cfAbort = controller;
		const reqId = ++__cfRequestId;

		// Prepare request configuration based on resolved variation
		const requestConfig = isAuthor 
			? {
				url: `${aemauthorurl}${CONFIG.GRAPHQL_QUERY};path=${contentPath};variation=${v};ts=${Date.now()}`,
				method: 'GET',
				headers: { 'Content-Type': 'application/json' }
			}
			: {
				url: `${CONFIG.WRAPPER_SERVICE_URL}?${CONFIG.WRAPPER_SERVICE_PARAMS}`,
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					graphQLPath: `${aempublishurl}${CONFIG.GRAPHQL_QUERY}`,
					cfPath: contentPath,
					variation: v
				})
			};

		try {
			if (!isAuthor) console.log('[content-fragment] live: fetching GraphQL with variation', v);

			const response = await fetch(requestConfig.url, {
				method: requestConfig.method,
				headers: requestConfig.headers,
				...(requestConfig.body && { body: requestConfig.body }),
				signal: controller.signal
			});

			if (reqId !== __cfRequestId) { 
        return; 
      }
      if (!response.ok) {
				return;	
			}
			let offer;
			try {
				offer = await response.json();
      } catch (_) {
				return;
			}

			const cfReq = offer?.data?.ctaByPath?.item;
			if (!cfReq) {
				return;
			}

      const itemId = `urn:aemconnection:${contentPath}/jcr:content/data/${v}`;
      try { block.setAttribute('data-aue-type', 'container'); } catch (_) {}
			const imgUrl = isAuthor ? cfReq.bannerimage?._authorUrl : cfReq.bannerimage?._publishUrl;
			const buildBackgroundStyles = (url, withGradient) => {
				const src = (url || '').trim();
				const isWebp = /\.webp(\?|$)/i.test(src);
				const fallback = isWebp ? src.replace(/\.webp(\?|$)/i, '.jpg$1') : src;
				const base = withGradient
					? `background-image: linear-gradient(90deg,rgba(0,0,0,0.6), rgba(0,0,0,0.1) 80%), url(${fallback});`
					: `background-image: url(${fallback});`;
				if (!isWebp) return base;
				const set = withGradient
					? `background-image: linear-gradient(90deg,rgba(0,0,0,0.6), rgba(0,0,0,0.1) 80%), image-set(url("${src}") type("image/webp"), url("${fallback}") type("image/jpeg"));`
					: `background-image: image-set(url("${src}") type("image/webp"), url("${fallback}") type("image/jpeg"));`;
				return `${base} ${set}`;
			};

			let bannerContentStyle = '';
			let bannerDetailStyle = '';
			if (displayStyle === 'image-left') bannerContentStyle = buildBackgroundStyles(imgUrl, false);
			else if (displayStyle === 'image-right') bannerContentStyle = buildBackgroundStyles(imgUrl, false);
			else if (displayStyle === 'image-top') bannerContentStyle = buildBackgroundStyles(imgUrl, false);
			else if (displayStyle === 'image-bottom') bannerContentStyle = buildBackgroundStyles(imgUrl, false);
			else bannerDetailStyle = buildBackgroundStyles(imgUrl, true);

			block.innerHTML = `<div class='banner-content block ${displayStyle}' data-aue-resource=${itemId} data-aue-label="Offer Content fragment" data-aue-type="reference" data-aue-filter="contentfragment" style="${bannerContentStyle}">
				<div class='banner-detail ${alignment}' style="${bannerDetailStyle}" data-aue-prop="bannerimage" data-aue-label="Main Image" data-aue-type="media" >
						<p data-aue-prop="title" data-aue-label="Title" data-aue-type="text" class='cftitle'>${cfReq?.title}</p>
						<p data-aue-prop="subtitle" data-aue-label="SubTitle" data-aue-type="text" class='cfsubtitle'>${cfReq?.subtitle}</p>
						<div data-aue-prop="description" data-aue-label="Description" data-aue-type="richtext" class='cfdescription'><p>${cfReq?.description?.plaintext || ''}</p></div>
						<p class="button-container ${ctaStyle}"><a href="${cfReq?.ctaUrl ? cfReq.ctaUrl : '#'}" data-aue-prop="ctaUrl" data-aue-label="Button Link/URL" data-aue-type="reference"  target="_blank" rel="noopener" data-aue-filter="page" class='button'><span data-aue-prop="ctalabel" data-aue-label="Button Label" data-aue-type="text">${cfReq?.ctalabel}</span></a></p>
				</div>
				<div class='banner-logo'></div>
			</div>`;

			// Keep the plain field updated so publish can read it
			persistVariationToDom(v);

			block.__cfRenderedFor = v;

    } catch (_) { }
	};

	// Try resolve variation from authored block resource in author mode
	if (isAuthor && !variationname) {
		try {
			// Ensure auth details for fetching JSON
			await ensureUeConnection();
			const authored = (block.dataset && (block.dataset.aueResource || block.dataset["aueResource"])) || '';
			if (authored) {
				const path = authored.replace('urn:aemconnection:', '');
				const cfRootModel = await fetchCfRootModelJson(path);
				const json = cfRootModel?.json || null;
				console.log('[content-fragment] cfRootModel:', json);
				const resolved = json ? pickVariation(json) : undefined;
				console.log('[content-fragment] resolved:', resolved);
				if (typeof resolved === 'string' && resolved) {
					variationname = resolved.toLowerCase().replace(' ', '_');
					persistVariationToDom(variationname);
					console.log('[content-fragment] variationname:', variationname);
				}
			}
		} catch (_) { /* ignore */ }
	}

	// Live/publish: read persisted variation from authored HTML
	if (!isAuthor) {
		const pubVar = readVariationFromPublishedDom();
		if (pubVar) variationname = pubVar;
	}

	// Fallback to master variation if still empty
	if (!variationname) {
		variationname = 'master';
		console.warn('[content-fragment] live: variation missing, falling back to', variationname);
	}

	// Ensure UE connection (for auth headers) then fetch using the consolidated helper
	console.log('[content-fragment] using variationname:', variationname);
	await ensureUeConnection();
	await fetchAndRender(variationname);

	// Author: mirror contentFragmentVariation -> variation and persist to attribute
	if (isAuthor && !block.__cfPropChangedAttached) {
		const onPropChanged = async (e) => {
			try {
				const { target, detail } = e || {};
				if (!detail || !block.contains(target)) return;
				const changedProp = detail?.prop || '';

				if (changedProp === 'contentFragmentVariation' && typeof detail?.value === 'string') {
					const next = String(detail.value).toLowerCase().replace(' ', '_');
					if (next) {
						persistVariationToDom(next);
						if (variationname !== next) {
							variationname = next;
							await fetchAndRender(variationname);
						}
					}
					return;
				}
			} catch (_) { /* ignore */ }
		};

		window.addEventListener('aue:prop:changed', onPropChanged, true);
		block.__cfPropChangedAttached = true;
		block.__cfPropChangedHandler = onPropChanged;
	}
}

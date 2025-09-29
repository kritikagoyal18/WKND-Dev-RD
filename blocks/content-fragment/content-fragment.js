import { getMetadata } from '../../scripts/aem.js';
import { isAuthorEnvironment } from '../../scripts/scripts.js';

/**
 *
 * @param {Element} block
 */
export default async function decorate(block) {
  const CONFIG = {
    WRAPPER_SERVICE_URL: 'https://prod-31.westus.logic.azure.com:443/workflows/2660b7afa9524acbae379074ae38501e/triggers/manual/paths/invoke',
    WRAPPER_SERVICE_PARAMS: 'api-version=2016-06-01&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=kfcQD5S7ovej9RHdGZFVfgvA-eEqNlb6r_ukuByZ64o',
    GRAPHQL_QUERY: '/graphql/execute.json/wknd-universal/CTAByPath'
  };
	
	const hostname = getMetadata('hostname');	
  const aemauthorurl = getMetadata('authorurl') || '';
	
  const aempublishurl = hostname?.replace('author', 'publish')?.replace(/\/$/, '');  
	
  const contentPath = block.querySelector(':scope div:nth-child(1) > div a')?.textContent?.trim();
	
	let variationname = "";
	const displayStyle = block.querySelector(':scope div:nth-child(3) > div')?.textContent?.trim() || '';
	const alignment = block.querySelector(':scope div:nth-child(4) > div')?.textContent?.trim() || '';
	const ctaStyle = block.querySelector(':scope div:nth-child(5) > div')?.textContent?.trim() || 'button';

  // Do not clear immediately; preserve current child structure until new markup is ready

  const isAuthor = isAuthorEnvironment();
  console.log('[content-fragment] init:', { isAuthor, contentPath });

	// Debug helper: log all elements under this block's :scope
	const logScopeElements = (label) => {
		try {
			const elements = block.querySelectorAll(':scope *');
			console.log('[content-fragment] :scope', label || '', 'count=', elements.length);
			elements.forEach((el, idx) => {
				const aueProp = el.getAttribute('data-aue-prop');
				const aueRes = el.getAttribute('data-aue-resource');
				const aueType = el.getAttribute('data-aue-type');
				const classes = (el.className || '').toString();
				const text = (el.textContent || '').trim().slice(0, 120);
				console.log('[content-fragment] :scope[%d]', idx, { tag: el.tagName?.toLowerCase?.(), classes, aueProp, aueRes, aueType, text });
			});
		} catch (_) { /* ignore */ }
	};

	// Initial dump (pre-render)
	logScopeElements('before-render');

	// Dedup/race-safety for GraphQL fetches
	let __cfRequestId = 0;
  let __cfAbort = null;
  let __cfInFlightVariation = '';

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
			}
			for (const key of Object.keys(node)) {
				const child = node[key];
				const found = pickVariation(child);
				if (found != null) return found;
			}
			return undefined;
		} catch (_) { return undefined; }
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
		if (__cfInFlightVariation === v) {
			console.log('[content-fragment] skip GraphQL (in-flight variation):', v);
			return;
		}
		__cfInFlightVariation = v;
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
			if (requestConfig.method === 'GET') {
				console.log('[content-fragment] GraphQL GET:', requestConfig.url);
			} else {
				console.log('[content-fragment] GraphQL POST:', { url: requestConfig.url, body: requestConfig.body });
			}
			const response = await fetch(requestConfig.url, {
				method: requestConfig.method,
				headers: requestConfig.headers,
				...(requestConfig.body && { body: requestConfig.body }),
				signal: controller.signal
			});
			if (reqId !== __cfRequestId) { console.log('[content-fragment] stale GraphQL response ignored'); __cfInFlightVariation = ''; return; }
			console.log('[content-fragment] GraphQL status:', response.status);
            if (!response.ok) {
				console.error('[content-fragment] GraphQL request failed', { status: response.status, contentPath, variation: v, isAuthor });
				__cfInFlightVariation = '';
				return;
			}
			let offer;
			try {
				offer = await response.json();
				console.log('[content-fragment] GraphQL response parsed');
            } catch (_) {
				console.error('[content-fragment] GraphQL response parse error');
				__cfInFlightVariation = '';
				return;
			}

			const cfReq = offer?.data?.ctaByPath?.item;
			if (!cfReq) {
        console.error('[content-fragment] GraphQL data empty', { contentPath, variation: v });
				__cfInFlightVariation = '';
				return;
			}

			// Render
      const itemId = `urn:aemconnection:${contentPath}/jcr:content/data/${v}`;
      // Mark wrapper as container so inner reference is not promoted to a sibling block
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

			// Dump :scope after render
			logScopeElements('after-render');

			// Derive variationname from first :scope element's data-aue-resource last segment
			try {
				const firstEl = block.querySelector(':scope *');
        console.log('[content-fragment] firstEl:', firstEl);
				const aueRes = firstEl && firstEl.getAttribute('data-aue-resource');
        console.log('[content-fragment] aueRes:', aueRes);
				if (aueRes) {
					const lastSegment = aueRes.split('/').pop() || '';
					const derived = String(lastSegment).toLowerCase().replace(' ', '_');
          console.log('[content-fragment] derived:', derived);
					if (derived) {
						variationname = derived;
						console.log('[content-fragment] variation derived from aueRes:', variationname);
					}
				}
			} catch (_) { /* ignore */ }

			block.__cfRenderedFor = v;
			__cfInFlightVariation = '';

    } catch (_) { __cfInFlightVariation = ''; }
	};

	if (isAuthor) {
    console.log('[content-fragment] attempting variation resolve');
    const findCfVariationForPath = (node, cfPath) => {
      try {
        if (!node || typeof node !== 'object') return undefined;
        if (node.model === 'contentfragment' && typeof node.reference === 'string') {
          if (node.reference === cfPath) {
            return node.contentFragmentVariation;
          }
        }
        for (const key of Object.keys(node)) {
          const child = node[key];
          const found = findCfVariationForPath(child, cfPath);
          if (found != null) return found;
        }
        return undefined;
      } catch (_) { return undefined; }
    };

		// Helper: find previous page-root overlay button relative to a given overlay button
		const findPrevRootOverlay = (startEl) => {
			try {
				let el = startEl?.previousElementSibling || null;
				while (el) {
					const res = el.getAttribute && el.getAttribute('data-resource');
					if (typeof res === 'string' && res.includes('/jcr:content/root/')) return el;
					el = el.previousElementSibling;
				}
				let parent = startEl?.parentElement || null;
				for (let i = 0; i < 3 && parent; i += 1) {
					let sib = parent.previousElementSibling;
					while (sib) {
						const res = sib.getAttribute && sib.getAttribute('data-resource');
						if (typeof res === 'string' && res.includes('/jcr:content/root/')) return sib;
						sib = sib.previousElementSibling;
					}
					parent = parent.parentElement;
				}
				return null;
			} catch (_) { return null; }
		};

		// Helper: recursively pick contentFragmentVariation from JSON nodes
		const pickVariation = (node) => {
			try {
				if (!node || typeof node !== 'object') return undefined;
				if (node.model === 'contentfragment' && typeof node.contentFragmentVariation === 'string') {
					return node.contentFragmentVariation;
				}
				for (const key of Object.keys(node)) {
					const child = node[key];
					const found = pickVariation(child);
					if (found != null) return found;
				}
				return undefined;
			} catch (_) { return undefined; }
		};
	}

	// Fallback to master variation if still empty
	if (!variationname) {
		variationname = 'master';
		console.log('[content-fragment] variation fallback to default:', variationname);
	}

  // Ensure UE connection (for auth headers) then fetch using the consolidated helper
	console.log('[content-fragment] using variationname:', variationname);
  await ensureUeConnection();
  await fetchAndRender(variationname);

	// Universal Editor integration: when this content-fragment block is selected in author,
	if (isAuthor && !block.__cfUeSelectAttached) {
    console.log('[content-fragment] attaching UE select handler');
    const getClosestResourceEl = (el) => el?.closest('[data-aue-resource]') || block.querySelector('[data-aue-resource]') || null;
    const pickVariation = (node) => {
      try {
        if (!node || typeof node !== 'object') return undefined;
        if (node.model === 'contentfragment' && typeof node.contentFragmentVariation === 'string') {
          return node.contentFragmentVariation;
        }
        for (const key of Object.keys(node)) {
          const child = node[key];
          const found = pickVariation(child);
          if (found != null) return found;
        }
        return undefined;
      } catch (_) { return undefined; }
    };

    const onUeSelect = async (e) => {
      // Keep the authored variation field in sync when CF reference changes
      try {
        const detail = e?.detail || {};
        const changedProp = detail?.prop || e?.target?.dataset?.aueProp || '';
        if (changedProp === 'reference' && typeof variationname === 'string' && variationname) {
          const snapshotBefore = block.querySelector('[data-aue-prop="variation"]')?.textContent || '';
          if (snapshotBefore !== variationname) {
            try { block.querySelector('[data-aue-prop="variation"]').textContent = variationname; } catch (_) {}
            console.log('[content-fragment] variation synced to authored field:', { previous: snapshotBefore, next: variationname });
          }
        }
      } catch (_) { /* ignore */ }
      console.log('[content-fragment] onUeSelect');
      const { target, detail } = e;
      if (!detail?.selected) return;
      if (!block.contains(target)) return;
      const blockName = block.dataset.blockName || 'content-fragment';
      const resourceEl = getClosestResourceEl(target);
      const resource = resourceEl?.getAttribute('data-aue-resource') || null;
      const selectedPath = resource ? resource.replace('urn:aemconnection:', '') : '';
      // Determine the nearest previous overlay button with a page root path
      const selectedOverlayBtn = (target.closest && target.closest('button.overlay,[data-resource]')) || null;
      const findPrevRootOverlay = (startEl) => {
        try {
          let el = startEl?.previousElementSibling || null;
          while (el) {
            const res = el.getAttribute && el.getAttribute('data-resource');
            if (typeof res === 'string' && res.includes('/jcr:content/root/')) return el;
            el = el.previousElementSibling;
          }
          // walk up a couple levels to be safe
          let parent = startEl?.parentElement || null;
          for (let i = 0; i < 3 && parent; i += 1) {
            let sib = parent.previousElementSibling;
            while (sib) {
              const res = sib.getAttribute && sib.getAttribute('data-resource');
              if (typeof res === 'string' && res.includes('/jcr:content/root/')) return sib;
              sib = sib.previousElementSibling;
            }
            parent = parent.parentElement;
          }
          return null;
        } catch (_) { return null; }
      };
      const prevRootBtn = findPrevRootOverlay(selectedOverlayBtn);
      const blockResource = prevRootBtn?.getAttribute?.('data-resource') || '';
      const blockSelectedPath = blockResource ? blockResource.replace('urn:aemconnection:', '') : '';
      // eslint-disable-next-line no-console
      console.log('[content-fragment] selected block path:', blockSelectedPath || selectedPath || '(none)');
      const cfRootModel = await fetchCfRootModelJson(blockSelectedPath || selectedPath);
      const json = cfRootModel?.json || null;
      // reuse shared pickVariation
      const contentFragmentVariation = json ? pickVariation(json) : undefined;
      console.log('[content-fragment] contentFragmentVariation:', contentFragmentVariation ?? '(not found)');
      if (contentFragmentVariation && typeof contentFragmentVariation === 'string') {
        variationname = contentFragmentVariation.toLowerCase().replace(' ', '_');
        await fetchAndRender(variationname);
      }
    };

    window.addEventListener('aue:ui-select', onUeSelect, true);
    block.__cfUeSelectAttached = true;
    block.__cfUeSelectHandler = onUeSelect;

    // Also listen for property changes (e.g., aem-content-fragment reference/variation changes)
    if (!block.__cfPropChangedAttached) {
      const findPrevRootOverlayLocal = (startEl) => {
        try {
          let el = startEl?.previousElementSibling || null;
          while (el) {
            const res = el.getAttribute && el.getAttribute('data-resource');
            if (typeof res === 'string' && res.includes('/jcr:content/root/')) return el;
            el = el.previousElementSibling;
          }
          let parent = startEl?.parentElement || null;
          for (let i = 0; i < 3 && parent; i += 1) {
            let sib = parent.previousElementSibling;
            while (sib) {
              const res = sib.getAttribute && sib.getAttribute('data-resource');
              if (typeof res === 'string' && res.includes('/jcr:content/root/')) return sib;
              sib = sib.previousElementSibling;
            }
            parent = parent.parentElement;
          }
          return null;
        } catch (_) { return null; }
      };

      const onPropChanged = async (e) => {
        try {
          const { target, detail } = e || {};
          if (!detail || !block.contains(target)) return;
          const changedProp = detail?.prop || '';
          // Log the change for observability
          console.log('[content-fragment] aue:prop:changed', { prop: changedProp, value: detail?.value });

          // If the author changed the variation in the CF widget, mirror it to the simple text field
          if (changedProp === 'contentFragmentVariation' && typeof detail?.value === 'string') {
            const next = String(detail.value).toLowerCase().replace(' ', '_');
            const snapshotBefore = block.querySelector('[data-aue-prop="variation"]')?.textContent || '';
            if (snapshotBefore !== next) {
              try { block.querySelector('[data-aue-prop="variation"]').textContent = next; } catch (_) {}
              variationname = next;
              console.log('[content-fragment] variation synced from CF widget:', { previous: snapshotBefore, next });
              await fetchAndRender(variationname);
            }
            return;
          }

          // If the author changed the CF reference, best-effort resolve the new variation and sync
          if (changedProp === 'reference') {
            // Try to resolve page-root path via overlays and read model
            const overlayForBlock = document.querySelector(`button.overlay[data-resource^="urn:aemconnection:${contentPath}/jcr:content/data/"]`) || document.querySelector(`button.overlay[data-resource^="${contentPath}/jcr:content/data/"]`);
            const prevRootBtn = overlayForBlock ? findPrevRootOverlayLocal(overlayForBlock) : null;
            const blockResource = prevRootBtn?.getAttribute?.('data-resource') || '';
            const path = blockResource ? blockResource.replace('urn:aemconnection:', '') : '';
            if (path) {
              const cfRootModel = await fetchCfRootModelJson(path);
              const json = cfRootModel?.json || null;
              const resolved = json ? (function pick(node){ try{ if(!node||typeof node!=='object') return undefined; if(node.model==='contentfragment'&& typeof node.contentFragmentVariation==='string') return node.contentFragmentVariation; for(const k of Object.keys(node)){ const f=pick(node[k]); if(f!=null) return f; } return undefined; } catch(_){ return undefined; } })(json) : undefined;
              if (typeof resolved === 'string' && resolved) {
                const next = resolved.toLowerCase().replace(' ', '_');
                const snapshotBefore = block.querySelector('[data-aue-prop="variation"]')?.textContent || '';
                if (snapshotBefore !== next) {
                  try { block.querySelector('[data-aue-prop="variation"]').textContent = next; } catch (_) {}
                  variationname = next;
                  console.log('[content-fragment] variation resolved after reference change:', { previous: snapshotBefore, next });
                  await fetchAndRender(variationname);
                }
              }
            }
          }
        } catch (_) { /* ignore */ }
      };

      window.addEventListener('aue:prop:changed', onPropChanged, true);
      block.__cfPropChangedAttached = true;
      block.__cfPropChangedHandler = onPropChanged;
    }
  }
}

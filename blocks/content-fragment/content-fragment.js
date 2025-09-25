import { getMetadata } from '../../scripts/aem.js';
import { isAuthorEnvironment } from '../../scripts/scripts.js';

/**
 *
 * @param {Element} block
 */
export default async function decorate(block) {
	// Configuration
  const CONFIG = {
    WRAPPER_SERVICE_URL: 'https://prod-31.westus.logic.azure.com:443/workflows/2660b7afa9524acbae379074ae38501e/triggers/manual/paths/invoke',
    WRAPPER_SERVICE_PARAMS: 'api-version=2016-06-01&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=kfcQD5S7ovej9RHdGZFVfgvA-eEqNlb6r_ukuByZ64o',
    GRAPHQL_QUERY: '/graphql/execute.json/wknd-universal/CTAByPath'
  };
	
	const hostname = getMetadata('hostname');	
  const aemauthorurl = getMetadata('authorurl') || '';
	
  const aempublishurl = hostname?.replace('author', 'publish')?.replace(/\/$/, '');  
	
  const contentPath = block.querySelector(':scope div:nth-child(1) > div a')?.textContent?.trim();
	
	const variationname = block.querySelector(':scope div:nth-child(2) > div')?.textContent?.trim()?.toLowerCase()?.replace(' ', '_') || 'master';
	const displayStyle = block.querySelector(':scope div:nth-child(3) > div')?.textContent?.trim() || '';
	const alignment = block.querySelector(':scope div:nth-child(4) > div')?.textContent?.trim() || '';
	const ctaStyle = block.querySelector(':scope div:nth-child(5) > div')?.textContent?.trim() || 'button';

  block.innerHTML = '';

  const isAuthor = isAuthorEnvironment();

	// Prepare request configuration based on environment
	const requestConfig = isAuthor 
  ? {
      url: `${aemauthorurl}${CONFIG.GRAPHQL_QUERY};path=${contentPath};variation=${variationname};ts=${Date.now()}`,
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
        variation: variationname
      })
    };

    try {
        // Fetch data
        const response = await fetch(requestConfig.url, {
          method: requestConfig.method,
          headers: requestConfig.headers,
          ...(requestConfig.body && { body: requestConfig.body })
        });

        if (!response.ok) {
					console.error(`error making cf graphql request:${response.status}`, {
	          error: error.message,
	          stack: error.stack,
	          contentPath,
	          variationname,
	          isAuthor
        	});
          block.innerHTML = '';
          return; // Exit early if response is not ok
        } 

        let offer;
        try {
          offer = await response.json();
        } catch (parseError) {
					console.error('Error parsing offer JSON from response:', {
	          error: error.message,
	          stack: error.stack,
	          contentPath,
	          variationname,
	          isAuthor
        	});
          block.innerHTML = '';
          return;
        }

        const cfReq = offer?.data?.ctaByPath?.item;

        if (!cfReq) {
          console.error('Error parsing response from GraphQL request - no valid data found', {
            response: offer,
            contentPath,
            variationname
          });
          block.innerHTML = '';
          return; // Exit early if no valid data
        }
        // Set up block attributes
        const itemId = `urn:aemconnection:${contentPath}/jcr:content/data/${variationname}`;
        block.setAttribute('data-aue-type', 'container');
        const imgUrl = isAuthor ? cfReq.bannerimage?._authorUrl : cfReq.bannerimage?._publishUrl;

        // Build background-image styles with WebP + JPEG fallback, preserving current CSS
        const buildBackgroundStyles = (url, withGradient) => {
          const src = (url || '').trim();
          const isWebp = /\.webp(\?|$)/i.test(src);
          const fallback = isWebp ? src.replace(/\.webp(\?|$)/i, '.jpg$1') : src;
          // First declaration is the safe fallback for browsers without image-set support
          const base = withGradient
            ? `background-image: linear-gradient(90deg,rgba(0,0,0,0.6), rgba(0,0,0,0.1) 80%), url(${fallback});`
            : `background-image: url(${fallback});`;
          if (!isWebp) return base;
          // Second declaration leverages image-set where supported; ignored otherwise
          const set = withGradient
            ? `background-image: linear-gradient(90deg,rgba(0,0,0,0.6), rgba(0,0,0,0.1) 80%), image-set(url("${src}") type("image/webp"), url("${fallback}") type("image/jpeg"));`
            : `background-image: image-set(url("${src}") type("image/webp"), url("${fallback}") type("image/jpeg"));`;
          return `${base} ${set}`;
        };

        // Determine the layout style
        const isImageLeft = displayStyle === 'image-left';
        const isImageRight = displayStyle === 'image-right';
        const isImageTop = displayStyle === 'image-top';
        const isImageBottom = displayStyle === 'image-bottom';
        
        
        // Set background image and styles based on layout
        let bannerContentStyle = '';
        let bannerDetailStyle = '';
        
        if (isImageLeft) {
          // Image-left layout: image on left, text on right
          bannerContentStyle = buildBackgroundStyles(imgUrl, false);
        } else if (isImageRight) {
          // Image-right layout: image on right, text on left
          bannerContentStyle = buildBackgroundStyles(imgUrl, false);
        } else if (isImageTop) {
          // Image-top layout: image on top, text on bottom
          bannerContentStyle = buildBackgroundStyles(imgUrl, false);
        } else if (isImageBottom) {
          // Image-bottom layout: text on top, image on bottom
          bannerContentStyle = buildBackgroundStyles(imgUrl, false);
        }  else {
          // Default layout: image as background with gradient overlay (original behavior)
          bannerDetailStyle = buildBackgroundStyles(imgUrl, true);
        }

        block.innerHTML = `<div class='banner-content block ${displayStyle}' data-aue-resource=${itemId} data-aue-label="Offer Content fragment" data-aue-type="reference" data-aue-filter="contentfragment" style="${bannerContentStyle}">
          <div class='banner-detail ${alignment}' style="${bannerDetailStyle}" data-aue-prop="bannerimage" data-aue-label="Main Image" data-aue-type="media" >
                <p data-aue-prop="title" data-aue-label="Title" data-aue-type="text" class='cftitle'>${cfReq?.title}</p>
                <p data-aue-prop="subtitle" data-aue-label="SubTitle" data-aue-type="text" class='cfsubtitle'>${cfReq?.subtitle}</p>
                
                <div data-aue-prop="description" data-aue-label="Description" data-aue-type="richtext" class='cfdescription'><p>${cfReq?.description?.plaintext || ''}</p></div>
                <p class="button-container ${ctaStyle}">
                  <a href="${cfReq?.ctaUrl ? cfReq.ctaUrl : '#'}" data-aue-prop="ctaUrl" data-aue-label="Button Link/URL" data-aue-type="reference"  target="_blank" rel="noopener" data-aue-filter="page" class='button'>
                    <span data-aue-prop="ctalabel" data-aue-label="Button Label" data-aue-type="text">
                      ${cfReq?.ctalabel}
                    </span>
                  </a>
                </p>
            </div>
            <div class='banner-logo'>
            </div>
        </div>`;

        if (isAuthor && !block.__cfUeConnInit) {
          block.__cfUeConnInit = true;

          const attachWithRetry = async () => {
            for (let i = 0; i < 5; i += 1) {
              try {
                const attach = window.adobe?.uix?.guest?.attach;
                if (typeof attach !== 'function') {
                  await new Promise((r) => setTimeout(r, 400));
                  continue;
                }
                const conn = await attach({ id: 'wknd-content-fragment' });
                return conn || null;
              } catch (_) {
                await new Promise((r) => setTimeout(r, 400));
              }
            }
            return null;
          };

          (async () => {
            try {
              const conn = await attachWithRetry();
              if (!conn) return;
              block.__cfUE = { conn };

              const token = conn?.sharedContext?.get?.('token');
              const scOrgId = conn?.sharedContext?.get?.('orgId');
              if (typeof token === 'string' && token) {
                console.log('[content-fragment] token', token);
                console.log('[content-fragment] token set');
              }

              let authorResolved = '';
              let connections = {};
              try {
                const initialState = await conn.host?.editorState?.get?.();
                connections = initialState?.connections || {};
                if (connections && typeof connections === 'object') {
                  const values = Object.values(connections);
                  const strVal = values.find((v) => typeof v === 'string');
                  if (typeof strVal === 'string') authorResolved = strVal;
                  if (!authorResolved) {
                    const objVal = values.find((v) => v && typeof v === 'object' && typeof v.url === 'string');
                    if (objVal) authorResolved = objVal.url;
                  }
                }
                if (authorResolved) authorResolved = authorResolved.replace(/^(aem:|xwalk:)/, '');
              } catch (_) { /* ignore */ }

              console.log('[content-fragment] UE host details:', { authorUrl: authorResolved, connections, orgId: scOrgId, tokenPresent: !!token });

              let apiKey = '';
              try { apiKey = window.localStorage.getItem('aemApiKey') || ''; } catch (_) { /* ignore */ }
              block.__cfAuth = {
                token: typeof token === 'string' ? token : '',
                orgId: typeof scOrgId === 'string' ? scOrgId : '',
                apiKey,
                authorUrl: authorResolved || aemauthorurl || window.location.origin,
              };
            } catch (_) { /* ignore */ }
          })();
        }

        // Universal Editor integration: when this content-fragment block is selected in author,
        // fetch and log both the block model JSON and the selected AEM resource's model JSON.
        if (isAuthor && !block.__cfUeSelectAttached) {
          const getClosestResourceEl = (el) => {
            return el?.closest('[data-aue-resource]') || block.querySelector('[data-aue-resource]') || null;
          };

          const fetchCfRootModelJson = async (selectedPath) => {
            try {
              const auth = block.__cfAuth || {};
              const authorBase = auth.authorUrl || aemauthorurl || window.location.origin;
              const url = `${authorBase}${selectedPath}.json`;
              console.log('[content-fragment] fetching cf root model json:', url);
              const headers = { 'Accept': 'application/json' };
              if (auth.token) headers['Authorization'] = `Bearer ${auth.token}`;
              if (auth.orgId) headers['x-gw-ims-org-id'] = auth.orgId;
              if (auth.apiKey) headers['x-api-key'] = auth.apiKey;
              const res = await fetch(url, { method: 'GET', headers, credentials: 'include', mode: 'cors' });
              console.log('[content-fragment] cf root model json response:', res);
              if (!res.ok) return { url, error: res.status };
              const json = await res.json();
              console.log('[content-fragment] cf root model json:', json);
              return { url, json };
            } catch (_) { return null; }
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

				// On initial render in author, attempt to resolve and fetch the block JSON without requiring selection
				(async () => {
					try {
						const resolveOnce = async () => {
							// find any overlay that points to our CF item resource
							const overlay = document.querySelector(`button.overlay[data-resource="${itemId}"]`) 
								|| document.querySelector(`button.overlay[data-resource="${itemId.replace('urn:aemconnection:', '')}"]`);
							if (!overlay) return false;
							const prevRootBtn = findPrevRootOverlay(overlay);
							const blockResource = prevRootBtn?.getAttribute?.('data-resource') || '';
							const path = blockResource ? blockResource.replace('urn:aemconnection:', '') : '';
							if (!path) return false;
							console.log('[content-fragment] initial block path:', path);
							const cfRootModel = await fetchCfRootModelJson(path);
							const json = cfRootModel?.json || null;
              const variation = json ? pickVariation(json) : undefined;
              console.log('[content-fragment] initial contentFragmentVariation:', variation ?? '(not found)');
              if (variation && typeof variation === 'string') variationname = variation.toLowerCase().replace(' ', '_');
              console.log('[content-fragment] initial variationname:', variationname);
							return true;
						};

						for (let i = 0; i < 8; i += 1) {
							const done = await resolveOnce();
							if (done) break;
							await new Promise((r) => setTimeout(r, 400));
						}
					} catch (_) { /* ignore */ }
				})();

          const onUeSelect = async (e) => {
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
            const contentFragmentVariation = json ? pickVariation(json) : undefined;
            console.log('[content-fragment] contentFragmentVariation:', contentFragmentVariation ?? '(not found)');
            if (contentFragmentVariation && typeof contentFragmentVariation === 'string') {
              variationname = contentFragmentVariation.toLowerCase().replace(' ', '_');
            }
          };

          window.addEventListener('aue:ui-select', onUeSelect, true);
          block.__cfUeSelectAttached = true;
          block.__cfUeSelectHandler = onUeSelect;
        }
      } catch (_) { block.innerHTML = ''; }

}

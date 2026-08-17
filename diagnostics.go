package main

// diagnosticScript runs inside the desktop window when DT_WEBVIEW_DIAG=1 and
// reports, through the bound __dtDiag function, what the page actually resolved
// to. It exists because the desktop window renders through WebKitGTK while the
// same URL in a browser renders through Blink or Gecko: a layout fault that
// appears only in the window cannot be diagnosed by looking at the browser, and
// guessing at the difference wastes everybody's time.
//
// It reads; it changes nothing.
const diagnosticScript = `
(function () {
	function report() {
		var out = [];
		function line(k, v) { out.push('  ' + k + ': ' + v); }

		var de = document.documentElement;
		out.push('viewport');
		line('window.innerWidth', window.innerWidth);
		line('window.innerHeight', window.innerHeight);
		line('window.outerWidth', window.outerWidth);
		line('documentElement.clientWidth', de.clientWidth);
		line('document.body.clientWidth', document.body ? document.body.clientWidth : 'no body');
		line('devicePixelRatio', window.devicePixelRatio);
		line('screen.width', window.screen ? window.screen.width : '?');
		line('visualViewport.width',
			window.visualViewport ? window.visualViewport.width : 'unsupported');
		line('visualViewport.scale',
			window.visualViewport ? window.visualViewport.scale : 'unsupported');

		var meta = document.querySelector('meta[name="viewport"]');
		line('viewport meta', meta ? ('STILL PRESENT: ' + meta.content) : 'removed');

		out.push('');
		out.push('media queries (chakra breakpoints)');
		[['base <30em', '(max-width: 29.99em)'],
		 ['sm >=30em', '(min-width: 30em)'],
		 ['md >=48em', '(min-width: 48em)'],
		 ['lg >=62em', '(min-width: 62em)'],
		 ['xl >=80em', '(min-width: 80em)']].forEach(function (q) {
			line(q[0], window.matchMedia(q[1]).matches);
		});

		out.push('');
		out.push('root chain');
		['html', 'body', '#root'].forEach(function (sel) {
			var el = sel === 'html' ? de : document.querySelector(sel);
			if (!el) { line(sel, 'not found'); return; }
			var cs = getComputedStyle(el);
			var r = el.getBoundingClientRect();
			line(sel, 'rect=' + Math.round(r.width) + 'x' + Math.round(r.height) +
				'  computed width=' + cs.width + '  display=' + cs.display +
				'  overflow=' + cs.overflow);
		});

		out.push('');
		out.push('font resolution');
		line('body font-family', document.body ? getComputedStyle(document.body).fontFamily : '?');
		line('body font-size', document.body ? getComputedStyle(document.body).fontSize : '?');
		if (document.fonts) {
			line('document.fonts.status', document.fonts.status);
			line('Inter loaded', document.fonts.check('16px Inter'));
			line('Source Sans 3 loaded', document.fonts.check('16px "Source Sans 3"'));
		}

		out.push('');
		out.push('the elements that looked wrong');
		var all = document.querySelectorAll('p, div, h1, h2');
		var found = 0;
		for (var i = 0; i < all.length && found < 6; i++) {
			var el = all[i];
			var t = (el.textContent || '').trim();
			if (el.children.length !== 0) continue;
			if (t.indexOf('This interactive tool brings together') !== 0 &&
				t.indexOf('Welcome to the Landscape') !== 0 &&
				t.indexOf('Explore how land management') !== 0 &&
				t.indexOf('This quick tour walks you') !== 0) continue;
			found++;
			var cs = getComputedStyle(el);
			var r = el.getBoundingClientRect();
			line('"' + t.slice(0, 34) + '"',
				'rect=' + Math.round(r.width) + 'x' + Math.round(r.height) +
				'  width=' + cs.width + '  max-width=' + cs.maxWidth +
				'  font-size=' + cs.fontSize + '  white-space=' + cs.whiteSpace +
				'  word-break=' + cs.wordBreak + '  overflow-wrap=' + cs.overflowWrap);
			var p = el.parentElement, depth = 0;
			while (p && depth < 3) {
				var pcs = getComputedStyle(p);
				var pr = p.getBoundingClientRect();
				line('    parent[' + depth + ']',
					'rect=' + Math.round(pr.width) + 'x' + Math.round(pr.height) +
					'  width=' + pcs.width + '  display=' + pcs.display +
					'  flex-direction=' + pcs.flexDirection +
					'  align-items=' + pcs.alignItems);
				p = p.parentElement; depth++;
			}
		}
		if (found === 0) { line('(none matched)', 'page may not have rendered yet'); }

		out.push('');
		out.push('engine');
		line('userAgent', navigator.userAgent);

		if (window.__dtDiag) { window.__dtDiag(out.join('\n')); }
	}

	// After load, and again shortly after, because webfonts and React both
	// settle asynchronously and the second reading is the one that matters.
	window.addEventListener('load', function () {
		setTimeout(report, 300);
		setTimeout(report, 2500);
	});
})();
`

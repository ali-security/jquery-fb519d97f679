/*
 * Seal fork-CI driver: runs the jQuery QUnit suite (test/index.html) in
 * headless Chrome via puppeteer-core and reports results on stdout.
 *
 * Usage: node test/seal-browser-runner.js <url> [module ...]
 *   With module names, each module runs in its own fresh page as
 *   "<url>&module=<name>", the way upstream CI (TestSwarm, build/tasks/
 *   testswarm.js) ran the suite; results are aggregated. Without, the whole
 *   suite runs in one page.
 *   CHROME_PATH       Chrome/Chromium executable (required)
 *   SEAL_TEST_FILTER  optional QUnit `filter` (substring of "module: test")
 *   SEAL_SKIP_TESTS   optional list of exact "module: test" names, separated by
 *                     newlines or "||" (a single "|" is NOT a separator: test
 *                     names such as "jQuery.get[Script|JSON]()" contain it).
 *                     Listed tests are never registered (printed as SKIPPED).
 *
 * Exit: 0 all green, 1 failures (or a page that ran zero tests), 2 timeout /
 * suite never finished / browser error.
 */

/* jshint node: true */

( function() {

"use strict";

var puppeteer = require( "puppeteer-core" ),
	OVERALL_TIMEOUT_MS = 40 * 60 * 1000,
	HEARTBEAT_MS = 120 * 1000,
	PREFIX = "__SEAL__",

	// es3 (test/.jshintrc) rejects reserved words as dotted property names
	GOTO = "goto",

	// Not "url": the suite declares a global url() helper (test/.jshintrc)
	suiteUrl = process.argv[ 2 ],
	moduleList = process.argv.slice( 3 ),
	filter = process.env.SEAL_TEST_FILTER || "",
	skipList = ( process.env.SEAL_SKIP_TESTS || "" )
		.split( /\r?\n|\|\|/ )
		.map( function( s ) {
			return s.replace( /^\s+|\s+$/g, "" );
		} )
		.filter( function( s ) {
			return s.length > 0;
		} );

if ( !suiteUrl ) {
	console.error( "usage: node test/seal-browser-runner.js <url> [module ...]" );
	process.exit( 2 );
}
if ( !process.env.CHROME_PATH ) {
	console.error( "CHROME_PATH is not set" );
	process.exit( 2 );
}
if ( filter ) {
	suiteUrl += ( suiteUrl.indexOf( "?" ) >= 0 ? "&" : "?" ) +
		"filter=" + encodeURIComponent( filter );
}

/*
 * Runs in every frame before any page script (serialized by puppeteer, so it
 * must be self-contained). Only the top frame is hooked: the suite spawns many
 * iframes, and some of them load QUnit themselves.
 */
function pageHook( skipNames ) {

	// Snapshot natives up front: some tests replace window.JSON (e.g. with a
	// parse-only stub) or console, and a reporter that throws from inside a
	// QUnit callback can wedge the whole suite.
	var nativeJSON = window.JSON,
		nativeStringify = nativeJSON.stringify,
		nativeConsole = window.console,
		nativeLog = nativeConsole.log,
		skip = {},
		hooked = false,
		qunitRef, i;

	if ( window.top !== window ) {
		return;
	}

	for ( i = 0; i < skipNames.length; i++ ) {
		skip[ skipNames[ i ] ] = true;
	}

	function emit( type, data ) {
		try {
			nativeLog.call( nativeConsole, "__SEAL__" +
				nativeStringify.call( nativeJSON, { type: type, data: data } ) );
		} catch ( e ) {
			try {
				nativeLog.call( nativeConsole, "__SEAL__" + nativeStringify.call( nativeJSON, {
					type: type,
					data: { error: "unserializable payload: " + e }
				} ) );
			} catch ( e2 ) {}
		}
	}

	function dump( value ) {
		var out;
		try {
			if ( qunitRef && qunitRef.dump ) {
				out = qunitRef.dump.parse( value );
			} else {
				out = String( value );
			}
		} catch ( e ) {
			try {
				out = String( value );
			} catch ( e2 ) {
				out = "<undumpable>";
			}
		}
		if ( typeof out === "string" && out.length > 2000 ) {
			out = out.slice( 0, 2000 ) + "...";
		}
		return out;
	}

	function hookQUnit( q ) {
		var origTest, wrappedTest;

		if ( hooked || !q || !q.config || !q.testDone ) {
			return;
		}
		hooked = true;

		// QUnit 1.17.1 assigns window.QUnit last, after QUnit.config and the
		// logging-callback registrars exist, so they can be used directly.
		q.config.reorder = false;

		// Skip support: every registration path (QUnit.test, window.test,
		// QUnit.asyncTest, the suite's ajaxTest/testIframe helpers) ends in a
		// property lookup of QUnit.test, where the current module is known.
		origTest = q.test;
		wrappedTest = function( testName ) {
			var mod = q.config.currentModule,
				key = ( mod && mod.name ? mod.name + ": " : "" ) + testName;
			if ( skip[ key ] ) {
				emit( "skip", { name: key } );
				return;
			}
			return origTest.apply( this, arguments );
		};
		q.test = wrappedTest;
		window.test = wrappedTest;

		q.begin( function() {
			emit( "begin", {} );
		} );
		q.moduleStart( function( d ) {
			emit( "moduleStart", { name: d.name } );
		} );
		q.testStart( function( d ) {
			emit( "testStart", { name: d.name, module: d.module } );
		} );
		q.log( function( d ) {
			if ( d.result ) {
				return;
			}
			emit( "log", {
				module: d.module,
				name: d.name,
				message: d.message === undefined ? "" : String( d.message ),
				actual: dump( d.actual ),
				expected: dump( d.expected ),
				source: d.source === undefined ? "" : String( d.source )
			} );
		} );
		q.testDone( function( d ) {
			emit( "testDone", {
				name: d.name,
				module: d.module,
				failed: d.failed,
				passed: d.passed,
				total: d.total
			} );
		} );
		q.done( function( d ) {
			emit( "done", {
				failed: d.failed,
				passed: d.passed,
				total: d.total,
				runtime: d.runtime
			} );
		} );
	}

	Object.defineProperty( window, "QUnit", {
		configurable: true,
		enumerable: true,
		get: function() {
			return qunitRef;
		},
		set: function( v ) {
			qunitRef = v;
			hookQUnit( v );
		}
	} );
}

function pad( s, n ) {
	s = String( s );
	while ( s.length < n ) {
		s += " ";
	}
	return s;
}

function main() {
	var browser, heartbeatTimer, overallTimer,
		finished = false,
		modules = {},
		moduleOrder = [],
		pages = [],
		failedTests = 0,
		passedTests = 0,
		passedAssertions = 0,
		failedAssertions = 0,
		skippedTests = [],
		current = null,
		currentTest = null,
		lastProgress = Date.now(),
		lastHeartbeat = Date.now();

	function moduleStats( name ) {
		if ( !modules[ name ] ) {
			modules[ name ] = { tests: 0, failedTests: 0, assertions: 0, failedAssertions: 0 };
			moduleOrder.push( name );
		}
		return modules[ name ];
	}

	function printSummary() {
		var totalTests = passedTests + failedTests,
			unmatched = skipList.filter( function( n ) {
				return skippedTests.indexOf( n ) < 0;
			} );

		console.log( "" );
		console.log( "==================== SUMMARY ====================" );
		if ( skippedTests.length ) {
			console.log( "Skipped (not registered): " + skippedTests.length );
			skippedTests.forEach( function( n ) {
				console.log( "  SKIPPED: " + n );
			} );
		}
		if ( unmatched.length ) {
			console.log( "WARNING: SEAL_SKIP_TESTS entries that matched no test:" );
			unmatched.forEach( function( n ) {
				console.log( "  UNMATCHED: " + n );
			} );
		}
		pages.forEach( function( p ) {
			console.log( "page " + p.label + ": " + ( p.done ?
				p.tests + " tests, " + p.failedTests + " failed; assertions " +
					p.done.passed + " passed, " + p.done.failed + " failed, " +
					p.done.total + " total; runtime " + p.done.runtime + " ms" :
				p.tests + " tests, " + p.failedTests + " failed; QUnit done NEVER fired" ) );
		} );
		console.log( pad( "module", 28 ) + pad( "tests", 8 ) + pad( "failed", 8 ) +
			pad( "assertions", 12 ) + "failed" );
		moduleOrder.forEach( function( name ) {
			var m = modules[ name ];
			console.log( pad( name, 28 ) + pad( m.tests, 8 ) + pad( m.failedTests, 8 ) +
				pad( m.assertions, 12 ) + m.failedAssertions );
		} );
		console.log( "Tests: " + passedTests + " passed, " + failedTests + " failed, " +
			totalTests + " total; Assertions: " + passedAssertions + " passed, " +
			failedAssertions + " failed, " + ( passedAssertions + failedAssertions ) +
			" total; pages: " + pages.length );
	}

	function finish( code, reason ) {
		var closing;

		if ( finished ) {
			return;
		}
		finished = true;
		clearInterval( heartbeatTimer );
		clearTimeout( overallTimer );
		if ( reason ) {
			console.log( reason );
		}
		printSummary();
		console.log( "RESULT: " + ( code === 0 ? "PASS" : "FAIL" ) + " (exit " + code + ")" );

		closing = browser ? browser.close() : Promise.resolve();
		closing.then( null, function() {} ).then( function() {
			process.exit( code );
		} );

		// Do not let a hung browser.close() keep us alive.
		setTimeout( function() {
			process.exit( code );
		}, 15000 ).unref();
	}

	function onEvent( ev ) {
		var m,
			d = ev.data || {};

		if ( !current ) {
			return;
		}

		switch ( ev.type ) {
		case "begin":
			console.log( "QUnit begin (" + current.label + ")" );
			break;
		case "moduleStart":
			console.log( "MODULE " + d.name );
			break;
		case "testStart":
			currentTest = ( d.module ? d.module + ": " : "" ) + d.name;
			break;
		case "log":
			console.log( "    assertion failed: " + d.message );
			console.log( "      expected: " + d.expected );
			console.log( "      actual:   " + d.actual );
			if ( d.source ) {
				console.log( "      source:   " +
					String( d.source ).split( "\n" ).join( "\n                " ) );
			}
			break;
		case "testDone":
			lastProgress = Date.now();
			lastHeartbeat = lastProgress;
			currentTest = null;
			m = moduleStats( d.module || "(no module)" );
			m.tests++;
			m.assertions += d.total;
			m.failedAssertions += d.failed;
			current.tests++;
			passedAssertions += d.passed;
			failedAssertions += d.failed;
			if ( d.failed > 0 ) {
				m.failedTests++;
				current.failedTests++;
				failedTests++;
			} else {
				passedTests++;
			}
			console.log( ( d.failed > 0 ? "FAIL" : "PASS" ) + " [" + d.module + "] " +
				d.name + " (" + d.passed + "/" + d.total + ")" );
			break;
		case "skip":

			// Every page loads every test file, so report each name once
			if ( skippedTests.indexOf( d.name ) < 0 ) {
				skippedTests.push( d.name );
				console.log( "SKIPPED: " + d.name );
			}
			break;
		case "done":
			current.done = d;
			current.resolve();
			break;
		default:
			console.log( "unknown reporter event: " + JSON.stringify( ev ) );
		}
	}

	// Load one suite page in a fresh tab and resolve when QUnit is done.
	function runPage( label, pageUrl ) {
		var page,
			state = { label: label, tests: 0, failedTests: 0, done: null };

		pages.push( state );
		current = state;
		console.log( "" );
		console.log( "==== PAGE " + label + ": " + pageUrl );

		return new Promise( function( resolve ) {
			state.resolve = resolve;
			browser.newPage().then( function( p ) {
				page = p;
				state.page = p;
				page.on( "console", function( msg ) {
					var ev,
						text = msg.text();
					if ( text.indexOf( PREFIX ) !== 0 ) {
						return;
					}
					try {
						ev = JSON.parse( text.slice( PREFIX.length ) );
					} catch ( e ) {
						console.log( "unparseable reporter line: " + text.slice( 0, 500 ) );
						return;
					}
					onEvent( ev );
				} );
				page.on( "pageerror", function( err ) {
					console.log( "PAGE ERROR: " +
						( err && err.message ? err.message : String( err ) ) );
				} );
				page.on( "dialog", function( dialog ) {
					console.log( "DIALOG (" + dialog.type() + "): " + dialog.message() );
					dialog.dismiss().then( null, function() {} );
				} );
				page.on( "error", function( err ) {
					finish( 2, "ERROR: page crashed: " +
						( err && err.message ? err.message : String( err ) ) );
				} );
				return page.evaluateOnNewDocument( pageHook, skipList );
			} ).then( function() {
				return page[ GOTO ]( pageUrl, { waitUntil: "load", timeout: 120000 } );
			} ).then( function() {
				console.log( "page loaded; waiting for QUnit done" );
			} ).then( null, function( err ) {
				finish( 2, "ERROR: " + ( err && err.stack ? err.stack : String( err ) ) );
			} );
		} ).then( function() {
			current = null;
			if ( state.tests === 0 ) {
				finish( 1, "ERROR: page " + label + " finished but zero tests ran" );
			}
			return page.close().then( null, function() {} );
		} );
	}

	overallTimer = setTimeout( function() {
		finish( 2, "TIMEOUT: suite did not finish within " + ( OVERALL_TIMEOUT_MS / 60000 ) +
			" minutes" + ( currentTest ? " (running: " + currentTest + ")" : "" ) );
	}, OVERALL_TIMEOUT_MS );

	heartbeatTimer = setInterval( function() {
		var now = Date.now();
		if ( now - lastHeartbeat >= HEARTBEAT_MS ) {
			lastHeartbeat = now;
			console.log( "HEARTBEAT: no test completed in " +
				Math.round( ( now - lastProgress ) / 1000 ) + "s; running: " +
				( currentTest || "(none / between tests)" ) );
		}
	}, 5000 );

	console.log( "URL: " + suiteUrl );
	console.log( "Pages: " + ( moduleList.length ?
		moduleList.length + " (one per module: " + moduleList.join( " " ) + ")" :
		"1 (whole suite)" ) );
	if ( skipList.length ) {
		console.log( "SEAL_SKIP_TESTS: " + skipList.length + " test(s)" );
		skipList.forEach( function( n ) {
			console.log( "  - " + n );
		} );
	}

	puppeteer.launch( {
		executablePath: process.env.CHROME_PATH,
		headless: true,
		args: [ "--no-sandbox", "--disable-gpu", "--force-device-scale-factor=1" ]
	} ).then( function( b ) {
		var chain = Promise.resolve();

		browser = b;
		browser.on( "disconnected", function() {
			finish( 2, "ERROR: browser disconnected before the suite finished" );
		} );

		if ( !moduleList.length ) {
			return runPage( "(all)", suiteUrl );
		}
		moduleList.forEach( function( mod ) {
			chain = chain.then( function() {
				if ( finished ) {
					return;
				}
				return runPage( "module=" + mod, suiteUrl +
					( suiteUrl.indexOf( "?" ) >= 0 ? "&" : "?" ) +
					"module=" + encodeURIComponent( mod ) );
			} );
		} );
		return chain;
	} ).then( function() {
		finish( failedTests === 0 && failedAssertions === 0 ? 0 : 1 );
	} ).then( null, function( err ) {
		finish( 2, "ERROR: " + ( err && err.stack ? err.stack : String( err ) ) );
	} );
}

main();

} )();

/* global setImmediate, after, console */
var messy = require('messy'),
    createMitm = require('mitm'),
    _ = require('underscore'),
    http = require('http'),
    https = require('https'),
    fs = require('fs'),
    stream = require('stream'),
    urlModule = require('url'),
    memoizeSync = require('memoizesync'),
    callsite = require('callsite'),
    detectIndent = require('detect-indent'),
    metadataPropertyNames = messy.HttpRequest.metadataPropertyNames.concat('rejectUnauthorized');

var isNodeZeroTen = !!process.version.match(/v0.10/);

function isRegExp(obj) {
    return Object.prototype.toString.call(obj) === '[object RegExp]';
}

function formatHeaderObj(headerObj) {
    var result = {};
    Object.keys(headerObj).forEach(function (headerName) {
        result[messy.formatHeaderName(headerName)] = headerObj[headerName];
    });
    return result;
}

function bufferCanBeInterpretedAsUtf8(buffer) {
    // Hack: Since Buffer.prototype.toString('utf-8') is very forgiving, convert the buffer to a string
    // with percent-encoded octets, then see if decodeURIComponent accepts it.
    try {
        decodeURIComponent(Array.prototype.map.call(buffer, function (octet) {
            return '%' + (octet < 16 ? '0' : '') + octet.toString(16);
        }).join(''));
    } catch (e) {
        return false;
    }
    return true;
}

function lineNumberToIndex(string, lineNumber) {
    var startOfLineIndex = 0;
    // decrement up front so we find the end of line of the line BEFORE
    lineNumber -= 1;

    while (lineNumber > 0) {
        // adding one after a newline gives us the start of the next line
        startOfLineIndex = string.indexOf('\n', startOfLineIndex) + 1;
        lineNumber -= 1;
    }

    return startOfLineIndex;
}

function trimMessage(message) {
    if (typeof message.body !== 'undefined') {
        if (message.body.length === 0) {
            delete message.body;
        } else if (new messy.Message({headers: {'Content-Type': message.headers['Content-Type']}}).hasTextualContentType && bufferCanBeInterpretedAsUtf8(message.body)) {
            message.body = message.body.toString('utf-8');
        }
        if (/^application\/json(?:;|$)/.test(message.headers['Content-Type']) && /^\s*[[{]/.test(message.body)) {
            try {
                message.body = JSON.parse(message.body);
                if (message.headers['Content-Type'] === 'application/json') {
                    delete message.headers['Content-Type'];
                }
            } catch (e) {}
        }
    }
    if (message.statusCode === 200) {
        delete message.statusCode;
    }
    if (message.headers) {
        delete message.headers['Content-Length'];
        delete message.headers['Transfer-Encoding'];
        delete message.headers.Connection;
        delete message.headers.Date;
        if (Object.keys(message.headers).length === 0) {
            delete message.headers;
        }
    }
    if (message.url && message.method) {
        message.url = message.method + ' ' + message.url;
        delete message.method;
    }
    if (Object.keys(message).length === 1) {
        if (typeof message.url === 'string') {
            return message.url;
        }
        if (typeof message.statusCode === 'number') {
            return message.statusCode;
        }
    }
    return message;
}

function trimRecordedExchange(recordedExchange) {
    return {
        request: trimMessage(recordedExchange.request),
        response: trimMessage(recordedExchange.response)
    };
}

function createSerializedRequestHandler(onRequest) {
    var activeRequest = false,
        requestQueue = [];

    function processNextRequest() {
        function cleanUpAndProceed() {
            if (activeRequest) {
                activeRequest = false;
                setImmediate(processNextRequest);
            }
        }
        while (requestQueue.length > 0 && !activeRequest) {
            activeRequest = true;
            var reqAndRes = requestQueue.shift(),
                req = reqAndRes[0],
                res = reqAndRes[1],
                resEnd = res.end;
            res.end = function () {
                resEnd.apply(this, arguments);
                cleanUpAndProceed();
            };
            // This happens upon an error, so we need to make sure that we catch that case also:
            res.on('close', cleanUpAndProceed);
            onRequest(req, res);
        }
    }

    return function (req, res) {
        requestQueue.push([req, res]);
        processNextRequest();
    };
}

function resolveExpectedRequestProperties(expectedRequestProperties) {
    if (typeof expectedRequestProperties === 'string') {
        expectedRequestProperties = { url: expectedRequestProperties };
    } else if (expectedRequestProperties && typeof expectedRequestProperties === 'object') {
        expectedRequestProperties = _.extend({}, expectedRequestProperties);
    }
    if (expectedRequestProperties) {
        if (typeof expectedRequestProperties.url === 'string') {
            var matchMethod = expectedRequestProperties.url.match(/^([A-Z]+) ([\s\S]*)$/);
            if (matchMethod) {
                expectedRequestProperties.method = expectedRequestProperties.method || matchMethod[1];
                expectedRequestProperties.url = matchMethod[2];
            }
        }
    } else {
        expectedRequestProperties = {};
    }
    if (/^https?:\/\//.test(expectedRequestProperties.url)) {
        var urlObj = urlModule.parse(expectedRequestProperties.url);
        expectedRequestProperties.headers = expectedRequestProperties.headers || {};
        if (Object.keys(expectedRequestProperties.headers).every(function (key) {
            return key.toLowerCase() !== 'host';
        })) {
            expectedRequestProperties.headers.host = urlObj.host;
        }
        expectedRequestProperties.host = expectedRequestProperties.host || urlObj.hostname;
        if (urlObj.port && typeof expectedRequestProperties.port === 'undefined') {
            expectedRequestProperties.port = parseInt(urlObj.port, 10);
        }

        if (urlObj.protocol === 'https:' && typeof expectedRequestProperties.encrypted === 'undefined') {
            expectedRequestProperties.encrypted = true;
        }
        expectedRequestProperties.url = urlObj.path;
    }

    var expectedRequestBody = expectedRequestProperties.body;
    if (Array.isArray(expectedRequestBody) || (expectedRequestBody && typeof expectedRequestBody === 'object' && !isRegExp(expectedRequestBody) && (typeof Buffer === 'undefined' || !Buffer.isBuffer(expectedRequestBody)))) {
        // in the case of a streamed request body and skip asserting the body
        if (typeof expectedRequestBody.pipe === 'function') {
            throw new Error('unexpected-mitm: a stream cannot be used to verify the request body, please specify the buffer instead.');
        }
        expectedRequestProperties.headers = expectedRequestProperties.headers || {};
        if (Object.keys(expectedRequestProperties.headers).every(function (key) {
            return key.toLowerCase() !== 'content-type';
        })) {
            expectedRequestProperties.headers['Content-Type'] = 'application/json';
        }
    }
    return expectedRequestProperties;
}

function createMockResponse(responseProperties) {
    if (typeof responseProperties === 'object' && responseProperties.body && (typeof responseProperties.body === 'string' || (typeof Buffer !== 'undefined' && Buffer.isBuffer(responseProperties.body)))) {
        responseProperties = _.extend({}, responseProperties);
        responseProperties.unchunkedBody = responseProperties.body;
        delete responseProperties.body;
    }
    var mockResponse = new messy.HttpResponse(responseProperties);
    mockResponse.statusCode = mockResponse.statusCode || 200;
    mockResponse.protocolName = mockResponse.protocolName || 'HTTP';
    mockResponse.protocolVersion = mockResponse.protocolVersion || '1.1';
    mockResponse.statusMessage = mockResponse.statusMessage || http.STATUS_CODES[mockResponse.statusCode];
    return mockResponse;
}

function hasTrailerChunk(chunk) {
    return isTrailerChunk(chunk.slice(-5));
}

function isTrailerChunk(chunk) {
    return chunk === '0\r\n\r\n';
}

function attachConnectionHook(connection, callback) {
    var rawChunks = [];
    var _write = connection._write;

    /*
     * wrap low level write to gather response data and return raw data
     * to callback when entire response is written
     */
    connection._write = function (chunk, encoding, cb) {
        var isBuffer = Buffer.isBuffer(chunk);

        rawChunks.push(isBuffer ? chunk : new Buffer(chunk));

        if (isTrailerChunk(chunk) || hasTrailerChunk(chunk)) {
            /*
             * explicitly execute the callback returning raw data here
             * to ensure it is run before issuing the final write which
             * will complete the request on the wire
             */
            callback(null, Buffer.concat(rawChunks));
        }

        _write.call(connection, chunk, encoding, cb);
    };
}

function attachResponseHooks(res, callback) {
    var hasEnded = false; // keep track of whether res.end() has been called

    attachConnectionHook(res.connection, function (err, rawBuffer) {
        if (hasEnded) {
            callback(null, rawBuffer);
        }
    });

    ['end', 'destroy'].forEach(function (methodName) {
        var orig = res[methodName];
        res[methodName] = function (chunk, encoding) {
            if (methodName === 'end') {
                hasEnded = true;
            }

            var returnValue = orig.apply(this, arguments);

            if (methodName === 'destroy') {
                hasEnded = true;
                callback(null);
            }

            // unconditionally return value given we do not wrap write
            return returnValue;
        };
    });
}

function determineInjectionCallsite(stack) {
    // discard the first frame
    stack.shift();

    // find the *next* frame outside a node_modules folder i.e. in user code
    var foundFrame = null;
    stack.some(function (stackFrame) {
        var stackFrameString = stackFrame.toString();

        if (stackFrameString.indexOf('node_modules') === -1) {
            foundFrame = stackFrame;
            return true;
        }
    });

    if (foundFrame) {
        return {
            fileName: foundFrame.getFileName(),
            lineNumber: foundFrame.getLineNumber()
        };
    } else {
        return null;
    }
}


module.exports = {
    name: 'unexpected-mitm',
    version: require('../package.json').version,
    installInto: function (expect) {
        expect.installPlugin(require('unexpected-messy'));

        var expectForRendering = expect.clone();

        expectForRendering.addType({
            name: 'infiniteBuffer',
            base: 'Buffer',
            identify: function (obj) {
                return Buffer.isBuffer(obj);
            },
            prefix: function (output) {
                return output.code('new Buffer([', 'javascript');
            },
            suffix: function (output) {
                return output.code('])', 'javascript');
            },
            hexDumpWidth: Infinity // Prevents Buffer instances > 16 bytes from being truncated
        });

        expectForRendering.addType({
            base: 'Error',
            name: 'overriddenError',
            identify: function (obj) {
                return this.baseType.identify(obj);
            },
            inspect: function (value, depth, output, inspect) {
                var obj = _.extend({}, value),
                    keys = Object.keys(obj);
                if (keys.length === 0) {
                    output.text('new Error(').append(inspect(value.message || '')).text(')');
                } else {
                    output
                        .text('(function () {')
                        .text('var err = new ' + (value.constructor.name || 'Error') + '(')
                        .append(inspect(value.message || '')).text(');');
                    keys.forEach(function (key, i) {
                        output.sp();
                        if (/^[a-z\$\_][a-z0-9\$\_]*$/i.test(key)) {
                            output.text('err.' + key);
                        } else {
                            output.text('err[').append(inspect(key)).text(']');
                        }
                        output.text(' = ').append(inspect(obj[key])).text(';');
                    });
                    output.sp().text('return err;}())');
                }
            }
        });

        function stringify(obj, indentationWidth, rendererOverride) {
            var renderer = rendererOverride || expectForRendering;
            renderer.output.indentationWidth = indentationWidth;
            return renderer.inspect(obj, Infinity).toString('text');
        }

        var injectionsBySourceFileName = {},
            getSourceText = memoizeSync(function (sourceFileName) {
                return fs.readFileSync(sourceFileName, 'utf-8');
            });

        function recordPendingInjection(injectionCallsite, recordedExchanges) {
            var sourceFileName = injectionCallsite.fileName,
                sourceLineNumber = injectionCallsite.lineNumber,
                sourceText = getSourceText(sourceFileName),
                // FIXME: Does not support tabs:
                indentationWidth = 4,
                detectedIndent = detectIndent(sourceText);
            if (detectedIndent) {
                indentationWidth = detectedIndent.amount;
            }
            var searchRegExp = /([ ]*)(.*)(['"])with http recorded and injected\3,/g;
            /*
             * Ensure the search for the for the assertion string occurs from
             * the line number of the callsite until it is found. Since we can
             * only set an index within the source string to search from, we
             * must convert that line number to such an index.
             */
            searchRegExp.lastIndex = lineNumberToIndex(sourceText, sourceLineNumber);
            // NB: Return value of replace not used:
            var matchSearchRegExp = searchRegExp.exec(sourceText);
            if (matchSearchRegExp) {
                var lineIndentation = matchSearchRegExp[1],
                    before = matchSearchRegExp[2],
                    quote = matchSearchRegExp[3];

                (injectionsBySourceFileName[sourceFileName] = injectionsBySourceFileName[sourceFileName] || []).push({
                    pos: matchSearchRegExp.index,
                    length: matchSearchRegExp[0].length,
                    replacement: lineIndentation + before + quote + 'with http mocked out' + quote + ', ' + stringify(recordedExchanges, indentationWidth).replace(/\n^/mg, '\n' + lineIndentation) + ','
                });
            } else {
                console.warn('unexpected-mitm: Could not find the right place to inject the recorded exchanges into ' + sourceFileName + ' (around line ' + sourceLineNumber + '): ' + stringify(recordedExchanges, indentationWidth, expect));
            }
        }

        function consumeReadableStream(readableStream, options) {
            options = options || {};
            var skipConcat = !!options.skipConcat;

            return expect.promise(function (resolve, reject) {
                var chunks = [];
                readableStream.on('data', function (chunk) {
                    chunks.push(chunk);
                }).on('end', function (chunk) {
                    resolve({ body: skipConcat ? chunks : Buffer.concat(chunks) });
                }).on('error', function (err) {
                    resolve({ body: skipConcat ? chunks : Buffer.concat(chunks), error: err });
                });
            });
        }

        function getMockResponse(responseProperties) {
            var mockResponse;
            var mockResponseError;
            if (Object.prototype.toString.call(responseProperties) === '[object Error]') {
                mockResponseError = responseProperties;
            } else {
                mockResponse = createMockResponse(responseProperties);
            }

            return expect.promise(function () {
                if (!mockResponseError && mockResponse && mockResponse.body && typeof mockResponse.body.pipe === 'function') {
                    return consumeReadableStream(mockResponse.body).then(function (result) {
                        if (result.error) {
                            mockResponseError = result.error;
                        }
                        if (result.body) {
                            mockResponse.unchunkedBody = result.body;
                        }
                    });
                }
            }).then(function () {
                if (mockResponse && !mockResponseError && (Array.isArray(mockResponse.body) || (mockResponse.body && typeof mockResponse.body === 'object' && (typeof Buffer === 'undefined' || !Buffer.isBuffer(mockResponse.body))))) {
                    if (!mockResponse.headers.has('Content-Type')) {
                        mockResponse.headers.set('Content-Type', 'application/json');
                    }
                }
                return [ mockResponse, mockResponseError ];
            });
        }

        function observeResponse(res) {
            return expect.promise(function (resolve, reject) {
                attachResponseHooks(res, function (err, rawBuffer) {
                    resolve(rawBuffer);
                });
            });
        }

        function performRequest(requestResult) {
            return expect.promise(function (resolve, reject) {
                (requestResult.encrypted ? https : http).request(_.extend({
                    headers: requestResult.headers,
                    method: requestResult.method,
                    host: requestResult.host,
                    port: requestResult.port,
                    path: requestResult.path
                }, requestResult.metadata)).on('response', function (response) {
                    consumeReadableStream(response).caught(reject).then(function (result) {
                        if (result.error) {
                            // TODO: Consider adding support for recording this (the upstream response erroring out while we're recording it)
                            return reject(result.error);
                        }

                        resolve({
                            statusCode: response.statusCode,
                            headers: response.headers,
                            body: result.body
                        });
                    });
                }).on('error', reject).end(requestResult.body);
            });
        }

        function applyInjections() {
            Object.keys(injectionsBySourceFileName).forEach(function (sourceFileName) {
                var injections = injectionsBySourceFileName[sourceFileName],
                    sourceText = getSourceText(sourceFileName),
                    offset = 0;
                injections.sort(function (a, b) {
                    return a.pos - b.pos;
                }).forEach(function (injection) {
                    var pos = injection.pos + offset;
                    sourceText = sourceText.substr(0, pos) + injection.replacement + sourceText.substr(pos + injection.length);
                    offset += injection.replacement.length - injection.length;
                });
                fs.writeFileSync(sourceFileName, sourceText, 'utf-8');
            });
        }

        function executeMitm(expect, subject) {
            var mitm = createMitm(),
                recordedExchanges = [];

            return expect.promise(function (resolve, reject) {
                var bypassNextConnect = false,
                    lastHijackedSocket,
                    lastHijackedSocketOptions;

                mitm.on('connect', function (socket, opts) {
                    if (bypassNextConnect) {
                        socket.bypass();
                        bypassNextConnect = false;
                    } else {
                        lastHijackedSocket = socket;
                        lastHijackedSocketOptions = opts;
                    }
                }).on('request', createSerializedRequestHandler(function (req, res) {
                    var metadata = _.extend(
                            {},
                            _.pick(lastHijackedSocketOptions.agent && lastHijackedSocketOptions.agent.options, metadataPropertyNames),
                            _.pick(lastHijackedSocketOptions, metadataPropertyNames)
                        ),
                        recordedExchange = {
                            request: _.extend({
                                url: req.method + ' ' + req.url,
                                headers: formatHeaderObj(req.headers)
                            }, metadata),
                            response: {}
                        };
                    recordedExchanges.push(recordedExchange);
                    consumeReadableStream(req).caught(reject).then(function (result) {
                        if (result.error) {
                            // TODO: Consider adding support for recording this (the request erroring out while we're recording it)
                            return reject(result.error);
                        }
                        recordedExchange.request.body = result.body;
                        bypassNextConnect = true;
                        var matchHostHeader = req.headers.host && req.headers.host.match(/^([^:]*)(?::(\d+))?/),
                            host,
                            port;

                        // https://github.com/moll/node-mitm/issues/14
                        if (matchHostHeader) {
                            if (matchHostHeader[1]) {
                                host = matchHostHeader[1];
                            }
                            if (matchHostHeader[2]) {
                                port = parseInt(matchHostHeader[2], 10);
                            }
                        }
                        if (!host) {
                            return reject(new Error('unexpected-mitm recording mode: Could not determine the host name from Host header: ' + req.headers.host));
                        }

                        performRequest({
                            encrypted: req.socket.encrypted,
                            headers: req.headers,
                            method: req.method,
                            host: host,
                            // default the port to HTTP values if not set
                            port: port || (req.socket.encrypted ? 443 : 80),
                            path: req.url,
                            body: result.body,
                            metadata: metadata
                        }).then(function (responseResult) {
                            recordedExchange.response.statusCode = responseResult.statusCode;
                            recordedExchange.response.headers = formatHeaderObj(responseResult.headers);
                            recordedExchange.response.body = responseResult.body;

                            setImmediate(function () {
                                res.statusCode = responseResult.statusCode;
                                Object.keys(responseResult.headers).forEach(function (headerName) {
                                    res.setHeader(headerName, responseResult.headers[headerName]);
                                });
                                res.end(recordedExchange.response.body);
                            });
                        }).caught(function (err) {
                            recordedExchange.response = err;
                            lastHijackedSocket.emit('error', err);
                        });
                    });
                }));

                expect.promise(function () {
                    return expect.shift();
                }).caught(reject).then(function () {
                    recordedExchanges = recordedExchanges.map(trimRecordedExchange);
                    if (recordedExchanges.length === 1) {
                        recordedExchanges = recordedExchanges[0];
                    }

                    resolve(recordedExchanges);
                });
            }).finally(function () {
                mitm.disable();
            });
        }

        var afterBlockRegistered = false;

        expect
            .addAssertion('<any> with http recorded [and injected] <assertion>', function (expect, subject) {
                var stack = callsite(),
                    injectIntoTest = this.flags['and injected'];

                if (injectIntoTest && !afterBlockRegistered) {
                    after(applyInjections);
                    afterBlockRegistered = true;
                }

                return executeMitm(expect, subject).then(function (recordedExchanges) {
                    if (injectIntoTest) {
                        var injectionCallsite = determineInjectionCallsite(stack);
                        if (injectionCallsite) {
                            recordPendingInjection(injectionCallsite, recordedExchanges);
                        }
                    }
                    return recordedExchanges;
                });
            })
            .addAssertion('<any> with http mocked out <array|object> <assertion>', function (expect, subject, requestDescriptions) { // ...
                expect.errorMode = 'nested';
                var mitm = createMitm();

                return expect.promise(function (resolve, reject) {
                    if (!Array.isArray(requestDescriptions)) {
                        if (typeof requestDescriptions === 'undefined') {
                            requestDescriptions = [];
                        } else {
                            requestDescriptions = [requestDescriptions];
                        }
                    } else {
                        // duplicate descriptions to allow array consumption
                        requestDescriptions = requestDescriptions.slice(0);
                    }

                    var httpConversation = new messy.HttpConversation(),
                        httpConversationSatisfySpec = {exchanges: []},
                        lastHijackedSocket,
                        lastHijackedSocketOptions;

                    mitm.on('connect', function (socket, opts) {
                        lastHijackedSocket = socket;
                        lastHijackedSocketOptions = opts;
                        if (typeof lastHijackedSocketOptions.port === 'string') {
                            // The port could have been defined as a string in a 3rdparty library doing the http(s) call, and that seems to be valid use of the http(s) module
                            lastHijackedSocketOptions = _.defaults({
                                port: parseInt(lastHijackedSocketOptions.port, 10)
                            }, lastHijackedSocketOptions);
                        }
                    }).on('request', createSerializedRequestHandler(function (req, res) {
                        var currentDescription = requestDescriptions.shift(),
                            hasRequestDescription = !!currentDescription,
                            metadata =
                                _.defaults(
                                    { encrypted: Boolean(res.connection.encrypted) },
                                    _.pick(lastHijackedSocketOptions, messy.HttpRequest.metadataPropertyNames),
                                    _.pick(lastHijackedSocketOptions && lastHijackedSocketOptions.agent && lastHijackedSocketOptions.agent.options, messy.HttpRequest.metadataPropertyNames)
                                ),
                            requestDescription = currentDescription,
                            responseProperties = requestDescription && requestDescription.response,
                            expectedRequestProperties;

                        expect.promise(function () {
                            expectedRequestProperties = resolveExpectedRequestProperties(requestDescription && requestDescription.request);
                        }).then(function () {
                            return consumeReadableStream(req, {skipConcat: true});
                        }).then(function (result) {
                            if (result.error) {
                                // TODO: Consider adding support for recording this (the request erroring out while we're consuming it)
                                throw result.error;
                            }
                            var requestProperties = _.extend({
                                method: req.method,
                                path: req.url,
                                protocolName: 'HTTP',
                                protocolVersion: req.httpVersion,
                                headers: req.headers,
                                unchunkedBody: Buffer.concat(result.body)
                            }, metadata);
                            var mockRequest = new messy.HttpRequest(requestProperties);

                            function assertMockResponse(mockResponse, mockResponseError) {
                                // if there was no mock arrange "<no response>"
                                if (!hasRequestDescription) {
                                    mockResponse = null;
                                }
                                var httpExchange = new messy.HttpExchange({request: mockRequest, response: mockResponse || mockResponseError});
                                httpConversation.exchanges.push(httpExchange);
                                // only attempt request validation with a mock
                                if (hasRequestDescription) {
                                    httpConversationSatisfySpec.exchanges.push({request: expectedRequestProperties});
                                }

                                /*
                                 * We explicitly do not complete the promise
                                 * when the last request for which we have a
                                 * mock is seen.
                                 *
                                 * Instead simply record any exchanges that
                                 * passed through and defer the resolution or
                                 * rejection to the handler functions attached
                                 * to the delegated assertion execution below.
                                 */
                            }

                            function deliverMockResponse(mockResponse, mockResponseError) {
                                setImmediate(function () {
                                    var nonEmptyMockResponse = false;
                                    if (mockResponse) {
                                        res.statusCode = mockResponse.statusCode;
                                        mockResponse.headers.getNames().forEach(function (headerName) {
                                            mockResponse.headers.getAll(headerName).forEach(function (value) {
                                                nonEmptyMockResponse = true;
                                                res.setHeader(headerName, value);
                                            });
                                        });
                                        var unchunkedBody = mockResponse.unchunkedBody;
                                        if (typeof unchunkedBody !== 'undefined' && unchunkedBody.length > 0) {
                                            nonEmptyMockResponse = true;
                                            res.write(unchunkedBody);
                                        } else if (nonEmptyMockResponse) {
                                            res.writeHead(res.statusCode || 200);
                                        }
                                    }
                                    if (mockResponseError) {
                                        setImmediate(function () {
                                            lastHijackedSocket.emit('error', mockResponseError);
                                            assertMockResponse(mockResponse, mockResponseError);
                                        });
                                    } else {
                                        res.end();
                                    }
                                });
                            }

                            /*
                             * hook final write callback to record raw data and immediately
                             * assert request so it occurs prior to request completion
                             */
                            observeResponse(res).then(function (rawBuffer) {
                                var mockResponse = createMockResponse(rawBuffer);
                                assertMockResponse(mockResponse);
                            });

                            if (typeof responseProperties === 'function') {
                                // reset the readable req stream state
                                stream.Readable.call(req);

                                // read stream data from the buffered chunks
                                req._read = function () {
                                    this.push(result.body.shift() || null);
                                };

                                if (isNodeZeroTen) {
                                    /*
                                     * As is mentioned in the streams documentation this
                                     * call can be issued to kick some of the machinery
                                     * and is apparently done within the standard lib.
                                     */
                                    req.read(0);
                                }

                                // call response function inside a promise to catch exceptions
                                expect.promise(function () {
                                    responseProperties(req, res);
                                }).caught(function (err) {
                                    // ensure delivery of the caught error to the underlying socket
                                    deliverMockResponse(null, err);
                                });
                            } else {
                                getMockResponse(responseProperties).spread(deliverMockResponse);
                            }
                        }).caught(function (e) {
                            /*
                             * This error handling path is triggered for any
                             * error occuring before a response is generated.
                             * In those circumstances, the deferred assertion
                             * will still be pending and must be completed. We
                             * do this by signalling the error on the socket.
                             */
                            lastHijackedSocket.emit('error', e);
                            reject(e);
                        });
                    }));

                    expect.promise(function () {
                        return expect.shift();
                    }).caught(reject).then(function () {
                        /*
                         * Handle the case of specified but unprocessed mocks.
                         * If there were none remaining immediately complete.
                         *
                         * Where the driving assertion resolves we must check
                         * if any mocks still exist. If so, we add them to the
                         * set of expected exchanges and resolve the promise.
                         */
                        var hasRemainingRequestDescriptions = requestDescriptions.length > 0;
                        if (hasRemainingRequestDescriptions) {
                            // exhaust remaining mocks using a promises chain
                            (function nextItem() {
                                var remainingDescription = requestDescriptions.shift();
                                if (remainingDescription) {
                                    var expectedRequestProperties;

                                    return expect.promise(function () {
                                        expectedRequestProperties = resolveExpectedRequestProperties(remainingDescription.request);
                                    }).then(function () {
                                        return getMockResponse(remainingDescription.response);
                                    }).spread(function (mockResponse, mockResponseError) {
                                        httpConversationSatisfySpec.exchanges.push({
                                            request: expectedRequestProperties,
                                            response: mockResponseError || mockResponse
                                        });

                                        return nextItem();
                                    }).caught(reject);
                                } else {
                                    resolve([httpConversation, httpConversationSatisfySpec]);
                                }
                            })();
                        } else {
                            resolve([httpConversation, httpConversationSatisfySpec]);
                        }
                    });
                }).spread(function (httpConversation, httpConversationSatisfySpec) {
                    expect.errorMode = 'default';
                    return expect(httpConversation, 'to satisfy', httpConversationSatisfySpec).then(function () {
                        // always resolve "with http mocked out" with exchanges
                        return [ httpConversation, httpConversationSatisfySpec ];
                    });
                }).finally(function () {
                    mitm.disable();
                });
            });
    }
};

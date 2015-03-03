unexpected-mitm
===============

[![NPM version](https://badge.fury.io/js/unexpected-mitm.png)](http://badge.fury.io/js/unexpected-mitm)
[![Build Status](https://travis-ci.org/unexpectedjs/unexpected-mitm.png)](https://travis-ci.org/unexpectedjs/unexpected-mitm)
[![Coverage Status](https://coveralls.io/repos/unexpectedjs/unexpected-mitm/badge.png)](https://coveralls.io/r/unexpectedjs/unexpected-mitm)
[![Dependency Status](https://david-dm.org/unexpectedjs/unexpected-mitm.png)](https://david-dm.org/unexpectedjs/unexpected-mitm)

![An unexpected man in the middle :)](logoImage.jpg)

Plugin for Unexpected that allows you to mock out http(s) traffic via [mitm](https://github.com/moll/node-mitm), but using a declarative syntax.

```js
var expect = require('unexpected')
    .installPlugin(require('unexpected-mitm'))
    .installPlugin(require('unexpected-http'));

it('should GET a mocked response', function (done) {
    expect('http://www.google.com/', 'with http mocked out', {
        request: 'GET /',
        response: {
            statusCode: 200,
            headers: {
                'Content-Type': 'text/plain'
            },
            body: 'Hey there!'
        }
    }, 'to yield response', {
        body: 'Hey there!'
    }, done);
});
```

License
-------

Unexpected-mitm is licensed under a standard 3-clause BSD license -- see the `LICENSE` file for details.

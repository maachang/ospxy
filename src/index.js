// httpsプロキシサーバ実装.
//

(function () {
    "use strict";
    const fs = require("fs");
    const http = require("http");
    const https = require("https");

    // コンフィグファイル名.
    const CONF_FILE = "ospxy.json";

    // コンフィグファイルが存在しない場合のデフォルト ospxy.json.
    const _DEF_CONF_JSON = {
        "//": "HTTPプロトコルバインド定義",
        "httpPort": 3128,
        "httpBindAddr": null,
        "//": "http or https serverの keepAliveタイムアウト(ミリ秒)",
        "keepAliveTimeout": null,
        "//": "http or https serverの 受信タイムアウト(ミリ秒)",
        "TIMEOUT": null
    }

    // メイン実行.
    const main = function () {
        // TLS 接続の証明書検証を無効にセット(これはclient接続用？).
        //process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';

        let conf = loadJson("./conf/" + CONF_FILE);
        if (conf == null) {
            conf = loadJson("./" + CONF_FILE);
        }
        if (conf == null) {
            //throw new Error("The ospxy.json file does not exist.");
            // 存在しない場合はデフォルトを利用.
            conf = _DEF_CONF_JSON;
        }
        // httpServerを構築.
        let httpServer = null;
        if (useString(conf["httpPort"])) {
            httpServer = createHttp(
                parseInt(conf["httpPort"]),
                conf["httpBindAddr"] || "0.0.0.0",
                conf
            );
        }
        // httpServerを実行.
        if (httpServer != null) {
            httpServer.start();
        }
        if (httpServer == null) {
            throw new Error("(ospxy.json) Server definition is invalid.: " +
                JSON.stringify(conf, null, "  "));
        }
    }

    // サーバータイムアウト(30秒).
    const TIMEOUT = 30 * 1000;

    // keep-alive タイムアウト(2.5秒).
    const KEEP_ALIVE_TIMEOUT = 2500;

    // httpプロキシサーバ生成.
    const createHttp = function (port, host, conf) {
        // host.
        let _host = "0.0.0.0";
        // port.
        let _port = 3128;
        // server.
        let _server = null;

        const ret = {};

        // バインドポートをセット.
        ret.setPort = function (port, host) {
            if (isNumeric(port)) {
                _port = port;
            }
            if (useString(host)) {
                _host = ("" + host).trim();
            }
            return ret;
        };

        // サーバ起動.
        ret.start = function () {
            if (_server != null) {
                throw new Error("The HTTPS server is already running.");
            }
            // httpサーバー生成.
            _server = http.createServer();
            // サーバオプション設定.
            _setServerOptions(_server, conf);
            // サーバーリクエストイベントセット.
            _server.on("request", function (req, res) {
                //console.log("request: " + req.url);
                _request(req, res);
            });
            // エラーハンドリング.
            _server.on("error", function (e) {
                console.log("server-Error");
                console.warn(e);
            });
            // bind.
            _server.listen(_port, _host);

            // log出力.
            console.log("## listen (port: " + _port + " addr: " + _host + ")");
        };

        // サーバークローズ.
        ret.close = function (call) {
            if (_server == null) {
                return false;
            }
            _server.close(function () {
                _server = null;
                if (tyoeof(call) == "function") {
                    try {
                        call.apply(null, arguments);
                    } catch (e) { }
                }
            });
            try {
                _server.closeAllConnections();
            } catch (e) { }
            return true;
        };

        // バインド対象のポートをセット.
        ret.setPort(port, host);
        return ret;
    }

    // nullチェック.
    const isNull = function (value) {
        return (value == undefined || value == null);
    }

    // 文字存在チェック.
    const useString = (function () {
        const _USE_STR_REG = /\S/g;
        return function (str) {
            let s = str;
            if (isNull(s)) {
                return false;
            }
            if (typeof (s) != "string") {
                if (!isNull(s["length"])) {
                    return s["length"] != 0;
                }
                s = "" + s;
            }
            return s.match(_USE_STR_REG) != undefined;
        }
    })();

    // 整数チェック.
    const isNumeric = function (n) {
        return Number(n) === n && n % 1 === 0;
    }

    // json情報をロード.
    const loadJson = function (name) {
        try {
            const ret = fs.readFileSync("" + name);
            return JSON.parse(ret.toString());
        } catch (e) { }
        return null;
    }

    // サーバーオプション設定.
    const _setServerOptions = function (server, json) {
        // タイムアウトセット.
        server.setTimeout(json["timeout"] || TIMEOUT);

        // [HTTP]キープアライブタイムアウトをセット.
        server.keepAliveTimeout =
            json.keepAliveTimeout || KEEP_ALIVE_TIMEOUT;

        // maxHeadersCountはゼロにセット.
        server.maxHeadersCount = 0;

        // http.socketオプションを設定.
        server.setMaxListeners(0);
        server.on("connection", function (socket) {
            // Nagle アルゴリズムを使用する.
            socket.setNoDelay(true);
            // tcp keepAliveを不許可.
            socket.setKeepAlive(false, 0);
        });
    }

    // リクエスト処理.
    const _request = function (req, res) {
        // イベント11超えでメモリーリーク警告が出るのでこれを排除.
        req.setMaxListeners(0);
        res.setMaxListeners(0);
        // https, http の両方で実行する.
        _reqBody(req, function (body) {
            const opt = _getServerRequest(req);
            opt["options"].reqBody = body;
            // proxy実行.
            _sendHttpsClient(opt, req, res);
        });
    }

    // requestBodyを取得.
    const _reqBody = function (req, call) {
        // requestのBodyを取得.
        let list = [];
        let binLen = 0;
        // データ取得.
        const dataCall = function (bin) {
            list.push(bin);
            binLen += bin.length;
        };
        // データ取得終了.
        const endCall = function () {
            cleanup();
            // 取得バイナリが存在しない場合.
            if (binLen == 0) {
                call("");
                return;
            }
            let n = null;
            let off = 0;
            let body = Buffer.allocUnsafe(binLen);
            binLen = null;
            const len = buf.length;
            // 取得内容を統合.
            for (let i = 0; i < len; i++) {
                n = list[i];
                n.copy(body, off);
                list[i] = null;
                off += n.length;
            }
            list = null;
            // コールバックを実行.
            call(body);
        }
        // エラー終了.
        const errCall = function (e) {
            cleanup();
            console.warn(e);
        }
        // クリーンアップ.
        const cleanup = function () {
            req.removeListener('data', dataCall);
            req.removeListener('end', endCall);
            req.removeListener('error', errCall);
        }
        // リクエストイベントセット.
        req.on('data', dataCall);
        req.once('end', endCall);
        req.once('error', errCall);
    }

    // serverRequest=reqの内容を取得.
    // この内容をHttpClientで利用する.
    // 取得内容は
    //  - url
    //  - options.method
    //  - options.headers
    const _getServerRequest = function (req) {
        try {
            const method = req.method;
            const headers = req.headers;
            // urlを取得.
            let url = req.url.trim();
            // urlのhttpを https に変更.
            if (url.startsWith("http://")) {
                url = "https://" + url.substring(7);
            } else if (!url.startsWith("https://")) {
                url = "https://" + url;
            }
            // リクエスト内容を返却.
            return {
                "url": url,
                "options": {
                    "method": method,
                    "headers": headers
                }
            };
        } catch (e) {
            console.log("## _getServerRequest")
            console.error(e);
        }
    }

    // httpsClientを生成してserverのrequestをhttpsClientのrequestに渡して
    // httpsClientのresponseをserevrのresponseに渡す.
    const _sendHttpsClient = function (conn, sreq, sres) {
        try {
            // clientRequest(https).
            const creq = https.request(conn.url, conn.options, function (cres) {
                try {
                    const state = cres.statusCode;
                    // イベント11超えでメモリーリーク警告が出るのでこれを排除.
                    cres.setMaxListeners(0);
                    // レスポンスステータスが 300 から 399 で
                    // locationヘッダが存在する場合は
                    // リダイレクトURLを http:// に置き換える.
                    if (state >= 300 && state <= 399 &&
                        useString(cres.headers["location"])) {
                        // httpモードの場合はレスポンスヘッダの
                        // location(urlProtocol)を書き換える.
                        let url = cres.headers["location"];
                        if (url.startsWith("https://")) {
                            url = "http://" + url.substring(8);
                            cres.headers["location"] = url;
                        }
                    }
                    // httpClientのresponseをサーバレスポンスに設定する.
                    sres.writeHead(cres.statusCode, cres.headers);
                    // bodyをpipeでセット.
                    cres.pipe(sres);
                    console.log("# [state: " + state + "]: url: " + conn.url);
                } catch (e) {
                    console.log("# [state: " + 500 + "]: url: " + conn.url);
                    console.error(e);
                    // 503エラーを返却.
                    _errorResponse(sres, 503);
                }
            });
            // sreq(serevrRequest)のbodyをcreq(httpClientRequest)に渡す.
            // イベント11超えでメモリーリーク警告が出るのでこれを排除.
            creq.setMaxListeners(0);
            // clientRequest: エラー処理.
            const errCall = function (e) {
                console.warn("# [error-https]: url: " + conn.url);
                // httpsアクセスでエラーの場合は
                // httpでアクセス.
                _sendHttpClient(conn, sres);
                return;
            }
            creq.on("error", errCall);
            // requestBodyをセット.
            creq.write(conn["options"].reqBody);
            creq.end();
        } catch (e) {
            console.log("##(ERROR)  _sendHttpsClient: " + conn.url)
            console.error(e);
            // 503エラーを返却.
            _errorResponse(sres, 503);
            console.log("# [state: " + 500 + "]: url: " + conn.url);
        }
    }

    // httpClientを生成してserverのrequestをhttpClientのrequestに渡して
    // httpClientのresponseをserevrのresponseに渡す.
    const _sendHttpClient = function (conn, sres) {
        // URLをhttpプロトコルに置き換える.
        const url = "http://" + conn.url.substring(8);
        try {
            // clientRequest(http).
            const creq = http.request(url, conn.options, function (cres) {
                try {
                    const state = cres.statusCode;
                    // イベント11超えでメモリーリーク警告が出るのでこれを排除.
                    cres.setMaxListeners(0);
                    // httpClientのresponseをサーバレスポンスに設定する.
                    sres.writeHead(cres.statusCode, cres.headers);
                    // bodyをpipeでセット.
                    cres.pipe(sres);
                    console.log("# [state: " + state + "]: url: " + url);
                } catch (e) {
                    console.log("# [state: " + 500 + "]: url: " + url);
                    console.error(e);
                    // 503エラーを返却.
                    _errorResponse(sres, 503);
                }
            });
            // sreq(serevrRequest)のbodyをcreq(httpClientRequest)に渡す.
            // イベント11超えでメモリーリーク警告が出るのでこれを排除.
            creq.setMaxListeners(0);
            // clientRequest: エラー処理.
            const errCall = function (e) {
                console.log("# [state: " + 500 + "]: url: " + url);
                creq.removeListener('error', errCall);
                console.warn(e);
                // 503エラーを返却.
                _errorResponse(sres, 503);
            }
            creq.on("error", errCall);
            // requestBodyをセット.
            creq.write(conn["options"].reqBody);
            creq.end();
        } catch (e) {
            console.log("# [state: " + 500 + "]: url: " + url);
            console.error(e);
            // 503エラーを返却.
            _errorResponse(sres, 503);
        }
    }

    // エラー処理.
    const _errorResponse = function (sres, errorState) {
        if (!isNumeric(errorState)) {
            errorState = 500;
        }
        sres.writeHead(errorState, {
            "content-length": "0",
            "server": "ospxy",
            "date": new Date().toISOString()
        });
        // 空返却.
        sres.end("");
    }

    // メイン実行.
    main();
})();

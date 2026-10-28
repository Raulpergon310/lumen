package app.lumen.tv;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ComponentName;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.util.Log;
import android.view.KeyEvent;
import android.view.View;
import android.view.WindowManager;
import android.webkit.ConsoleMessage;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.io.InputStream;
import java.util.HashMap;
import java.util.Map;

// Hosts the same web UI as the desktop app. The files are bundled in assets/web and served from a
// private http origin, so ES modules, workers and wasm load as they do in Electron. It must be http:
// from an https page Chromium silently upgrades http images/video of a LAN Jellyfin to https and
// they fail to load.
public class MainActivity extends Activity {
    private static final String TAG = "Lumen";
    private static final String HOST = "appassets.androidplatform.net";
    private static final String START_URL = "http://" + HOST + "/index.html";

    private static final int VIEWPORT_WIDTH = 1280;
    private static final String VLC = "org.videolan.vlc";
    private static final int REQ_EXTERNAL = 42;

    private WebView web;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().getDecorView().setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);

        // Remote inspection only in debug builds (LUMEN_DEBUG=1 bash android/build.sh).
        WebView.setWebContentsDebuggingEnabled((getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0);
        web = new WebView(this);
        web.setBackgroundColor(Color.BLACK);
        web.setVerticalScrollBarEnabled(false);
        web.setHorizontalScrollBarEnabled(false);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        // The TV reports 2x density (a 960x540 page): render the desktop layout at 1280 wide instead.
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        s.setUserAgentString(s.getUserAgentString() + " LumenTV/1.0");

        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                if (!HOST.equals(u.getHost())) return null;
                return serveAsset(u.getPath());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                return !HOST.equals(req.getUrl().getHost());
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onConsoleMessage(ConsoleMessage m) {
                Log.i(TAG, m.message() + " @ " + m.sourceId() + ":" + m.lineNumber());
                return true;
            }

            // Without this the WebView paints a grey "play" placeholder over videos before they start.
            @Override
            public Bitmap getDefaultVideoPoster() {
                return Bitmap.createBitmap(1, 1, Bitmap.Config.ARGB_8888);
            }
        });
        web.addJavascriptInterface(new Bridge(), "LumenTV");

        setContentView(web);
        web.requestFocus();
        web.loadUrl(START_URL);
    }

    private WebResourceResponse serveAsset(String path) {
        if (path == null || path.isEmpty() || path.equals("/")) path = "/index.html";
        if (path.contains("..")) return notFound();
        try {
            InputStream in = getAssets().open("web" + path);
            if (path.equals("/index.html")) in = withTvViewport(in);
            Map<String, String> headers = new HashMap<>();
            headers.put("Cache-Control", "no-cache");
            headers.put("Access-Control-Allow-Origin", "*");
            return new WebResourceResponse(mimeFor(path), null, 200, "OK", headers, in);
        } catch (Exception e) {
            return notFound();
        }
    }

    private static InputStream withTvViewport(InputStream in) throws java.io.IOException {
        java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
        in.close();
        String html = out.toString("UTF-8").replace("width=device-width, initial-scale=1", "width=" + VIEWPORT_WIDTH);
        return new java.io.ByteArrayInputStream(html.getBytes("UTF-8"));
    }

    private static WebResourceResponse notFound() {
        return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found", new HashMap<String, String>(), null);
    }

    private static String mimeFor(String path) {
        String p = path.toLowerCase();
        if (p.endsWith(".html")) return "text/html";
        if (p.endsWith(".js") || p.endsWith(".mjs")) return "text/javascript";
        if (p.endsWith(".css")) return "text/css";
        if (p.endsWith(".json")) return "application/json";
        if (p.endsWith(".svg")) return "image/svg+xml";
        if (p.endsWith(".png")) return "image/png";
        if (p.endsWith(".wasm")) return "application/wasm";
        if (p.endsWith(".woff2")) return "font/woff2";
        if (p.endsWith(".ttf")) return "font/ttf";
        return "application/octet-stream";
    }

    // Back goes to the web UI first (close the player, a menu, or go back a page); only on the
    // home screen with nothing open does it leave the app.
    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        if (event.getKeyCode() == KeyEvent.KEYCODE_BACK) {
            if (event.getAction() == KeyEvent.ACTION_UP) {
                web.evaluateJavascript("window.lumenTvBack ? lumenTvBack() : false", value -> {
                    if (!"true".equals(value)) finish();
                });
            }
            return true;
        }
        return super.dispatchKeyEvent(event);
    }

    // VLC hands back where playback stopped; the web UI reports it to Jellyfin.
    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != REQ_EXTERNAL) return;
        long pos = data != null ? data.getLongExtra("extra_position", -1) : -1;
        long dur = data != null ? data.getLongExtra("extra_duration", -1) : -1;
        externalDone(pos, dur, true);
    }

    private void externalDone(long pos, long dur, boolean ok) {
        web.evaluateJavascript("window.lumenTvExternalDone && lumenTvExternalDone(" + pos + "," + dur + "," + ok + ")", null);
    }

    // PackageInstaller answers an update commit here (the activity is singleTask).
    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        if (ApkUpdater.ACTION_STATUS.equals(intent.getAction())) ApkUpdater.onStatus(this, intent, this::updateReport);
    }

    private void updateReport(String state) {
        runOnUiThread(() -> web.evaluateJavascript("window.lumenTvUpdate && lumenTvUpdate(" + org.json.JSONObject.quote(state) + ")", null));
    }

    @Override
    protected void onPause() {
        super.onPause();
        web.evaluateJavascript("window.lumenTvPause && lumenTvPause()", null);
    }

    @Override
    protected void onDestroy() {
        if (web != null) web.destroy();
        super.onDestroy();
    }

    private class Bridge {
        @JavascriptInterface
        public void keepAwake(final boolean on) {
            runOnUiThread(() -> {
                if (on) getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            });
        }

        @JavascriptInterface
        public void log(String msg) {
            Log.i(TAG, msg);
        }

        @JavascriptInterface
        public boolean hasExternalPlayer() {
            try {
                getPackageManager().getPackageInfo(VLC, 0);
                return true;
            } catch (Exception e) {
                return false;
            }
        }

        @JavascriptInterface
        public void playExternal(final String url, final String title, final long startMs, final String subtitleUrl) {
            runOnUiThread(() -> {
                Intent i = new Intent(Intent.ACTION_VIEW);
                i.setComponent(new ComponentName(VLC, VLC + ".gui.video.VideoPlayerActivity"));
                i.setDataAndType(Uri.parse(url), "video/*");
                i.putExtra("title", title);
                i.putExtra("from_start", startMs <= 0);
                if (startMs > 0) i.putExtra("position", startMs);
                if (subtitleUrl != null && !subtitleUrl.isEmpty()) i.putExtra("subtitles_location", subtitleUrl);
                try {
                    startActivityForResult(i, REQ_EXTERNAL);
                } catch (ActivityNotFoundException e) {
                    Log.w(TAG, "VLC: " + e);
                    externalDone(-1, -1, false);
                }
            });
        }

        @JavascriptInterface
        public String appVersion() {
            try {
                return getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
            } catch (Exception e) {
                return "";
            }
        }

        @JavascriptInterface
        public void installUpdate(final String apkUrl) {
            runOnUiThread(() -> ApkUpdater.install(MainActivity.this, apkUrl, MainActivity.this::updateReport));
        }

        @JavascriptInterface
        public void exit() {
            runOnUiThread(MainActivity.this::finish);
        }
    }
}

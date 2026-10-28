package app.lumen.tv;

import android.app.Activity;
import android.app.PendingIntent;
import android.content.Intent;
import android.content.pm.PackageInstaller;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.util.Log;

import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

// Installs a newer APK from the project's GitHub release: downloads it straight into a
// PackageInstaller session (no file provider needed) and lets Android ask the user to confirm.
// The web UI is told how it goes through `report` ("downloading 42", "confirm", "error …").
class ApkUpdater {
    static final String ACTION_STATUS = "app.lumen.tv.INSTALL_STATUS";

    interface Report { void send(String state); }

    static void install(Activity activity, String apkUrl, Report report) {
        // Android 8+: the user must allow Lumen to install apps once.
        if (Build.VERSION.SDK_INT >= 26 && !activity.getPackageManager().canRequestPackageInstalls()) {
            report.send("permission");
            activity.startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:" + activity.getPackageName())));
            return;
        }
        new Thread(() -> {
            PackageInstaller.Session session = null;
            try {
                HttpURLConnection c = open(apkUrl);
                long total = c.getContentLengthLong();
                PackageInstaller pi = activity.getPackageManager().getPackageInstaller();
                PackageInstaller.SessionParams params = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
                if (total > 0) params.setSize(total);
                session = pi.openSession(pi.createSession(params));
                try (InputStream in = c.getInputStream(); OutputStream out = session.openWrite("lumen.apk", 0, total)) {
                    byte[] buf = new byte[64 * 1024];
                    long done = 0;
                    int last = -1;
                    for (int n; (n = in.read(buf)) > 0; ) {
                        out.write(buf, 0, n);
                        done += n;
                        int pct = total > 0 ? (int) (done * 100 / total) : 0;
                        if (pct != last) { last = pct; report.send("downloading " + pct); }
                    }
                    session.fsync(out);
                }
                Intent status = new Intent(activity, MainActivity.class).setAction(ACTION_STATUS);
                int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0);
                PendingIntent pending = PendingIntent.getActivity(activity, 7, status, flags);
                report.send("confirm");
                session.commit(pending.getIntentSender());
            } catch (Exception e) {
                Log.w("Lumen", "update: " + e);
                if (session != null) session.abandon();
                report.send("error " + e.getMessage());
            }
        }).start();
    }

    // Android answers the commit through MainActivity: ask the user to confirm, or report the result.
    static void onStatus(Activity activity, Intent intent, Report report) {
        int status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE);
        if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
            Intent confirm = intent.getParcelableExtra(Intent.EXTRA_INTENT);
            if (confirm != null) activity.startActivity(confirm);
        } else if (status != PackageInstaller.STATUS_SUCCESS) {
            report.send("error " + intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE));
        }
    }

    // GitHub sends release downloads through a redirect to another host.
    private static HttpURLConnection open(String url) throws Exception {
        for (int i = 0; i < 5; i++) {
            HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
            c.setInstanceFollowRedirects(false);
            c.setConnectTimeout(15000);
            c.setReadTimeout(30000);
            c.setRequestProperty("User-Agent", "LumenTV");
            int code = c.getResponseCode();
            if (code >= 300 && code < 400) { url = c.getHeaderField("Location"); c.disconnect(); continue; }
            if (code != 200) throw new Exception("HTTP " + code);
            return c;
        }
        throw new Exception("demasiadas redirecciones");
    }
}

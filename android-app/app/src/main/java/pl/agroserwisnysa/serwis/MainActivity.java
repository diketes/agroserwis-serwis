package pl.agroserwisnysa.serwis;

import android.annotation.SuppressLint;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.os.Environment;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import androidx.appcompat.app.AlertDialog;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.content.FileProvider;
import java.io.File;
import java.io.IOException;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

public class MainActivity extends AppCompatActivity {

    static final String PREFS = "agroserwis";
    static final String KEY_URL = "server_url";
    static final int SCAN_REQUEST = 42;
    static final int FILE_CHOOSER_REQUEST = 43;

    private WebView webView;
    private String serverUrl;
    private ValueCallback<Uri[]> filePathCallback;
    private Uri cameraOutputUri;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        serverUrl = prefs.getString(KEY_URL, null);

        if (serverUrl == null) {
            startScan();
            return;
        }

        showWebView();
    }

    private void startScan() {
        Intent intent = new Intent(this, ScanActivity.class);
        startActivityForResult(intent, SCAN_REQUEST);
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void showWebView() {
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.parseColor("#f1f5f9"));
        setContentView(root);

        webView = new WebView(this);
        webView.setLayoutParams(new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT));

        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setCacheMode(WebSettings.LOAD_NO_CACHE);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView wv, ValueCallback<Uri[]> filePathCb,
                                             FileChooserParams params) {
                if (filePathCallback != null) {
                    filePathCallback.onReceiveValue(null);
                }
                filePathCallback = filePathCb;
                cameraOutputUri = null;

                // Prepare camera intent with FileProvider output URI
                Intent cameraIntent = null;
                try {
                    File photoDir = new File(getCacheDir(), "camera");
                    photoDir.mkdirs();
                    String stamp = new SimpleDateFormat("yyyyMMdd_HHmmss", Locale.US).format(new Date());
                    File photoFile = new File(photoDir, "IMG_" + stamp + ".jpg");
                    cameraOutputUri = FileProvider.getUriForFile(
                            MainActivity.this,
                            getPackageName() + ".fileprovider",
                            photoFile);
                    cameraIntent = new Intent(android.provider.MediaStore.ACTION_IMAGE_CAPTURE);
                    cameraIntent.putExtra(android.provider.MediaStore.EXTRA_OUTPUT, cameraOutputUri);
                    cameraIntent.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_READ_URI_PERMISSION);
                } catch (Exception e) {
                    cameraOutputUri = null;
                }

                Intent galleryIntent = new Intent(Intent.ACTION_GET_CONTENT);
                galleryIntent.addCategory(Intent.CATEGORY_OPENABLE);
                galleryIntent.setType("image/*");

                Intent chooser = Intent.createChooser(galleryIntent, "Wybierz zdjęcie");
                if (cameraIntent != null) {
                    chooser.putExtra(Intent.EXTRA_INITIAL_INTENTS, new Intent[]{cameraIntent});
                }

                startActivityForResult(chooser, FILE_CHOOSER_REQUEST);
                return true;
            }
        });

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) {
                    showErrorPage();
                }
            }
        });

        webView.setOnLongClickListener(v -> {
            new AlertDialog.Builder(this)
                    .setTitle("Zmień serwer")
                    .setMessage("Zeskanować nowy kod QR?")
                    .setPositiveButton("Skanuj", (d, w) -> startScan())
                    .setNegativeButton("Anuluj", null)
                    .show();
            return true;
        });

        root.addView(webView);
        webView.loadUrl(serverUrl + "/mobile");
    }

    private void showErrorPage() {
        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        layout.setGravity(android.view.Gravity.CENTER);
        layout.setPadding(64, 64, 64, 64);
        layout.setBackgroundColor(Color.parseColor("#f1f5f9"));

        TextView icon = new TextView(this);
        icon.setText("📡");
        icon.setTextSize(64);
        icon.setGravity(android.view.Gravity.CENTER);
        layout.addView(icon);

        TextView title = new TextView(this);
        title.setText("Brak połączenia");
        title.setTextSize(22);
        title.setTextColor(Color.parseColor("#1e293b"));
        title.setTypeface(null, android.graphics.Typeface.BOLD);
        title.setGravity(android.view.Gravity.CENTER);
        title.setPadding(0, 24, 0, 12);
        layout.addView(title);

        TextView msg = new TextView(this);
        msg.setText("Sprawdź czy komputer z aplikacją jest włączony i podłączony do tej samej sieci WiFi.");
        msg.setTextSize(15);
        msg.setTextColor(Color.parseColor("#64748b"));
        msg.setGravity(android.view.Gravity.CENTER);
        msg.setPadding(0, 0, 0, 32);
        layout.addView(msg);

        Button retry = new Button(this);
        retry.setText("Spróbuj ponownie");
        retry.setBackgroundColor(Color.parseColor("#16a34a"));
        retry.setTextColor(Color.WHITE);
        retry.setPadding(48, 24, 48, 24);
        retry.setOnClickListener(v -> {
            setContentView(new FrameLayout(this));
            showWebView();
        });
        layout.addView(retry);

        Button rescan = new Button(this);
        rescan.setText("Zeskanuj nowy QR");
        rescan.setBackgroundColor(Color.TRANSPARENT);
        rescan.setTextColor(Color.parseColor("#16a34a"));
        rescan.setOnClickListener(v -> startScan());
        layout.addView(rescan);

        setContentView(layout);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);

        if (requestCode == FILE_CHOOSER_REQUEST) {
            if (filePathCallback == null) return;
            Uri[] results = null;
            if (resultCode == RESULT_OK) {
                if (data != null && data.getData() != null) {
                    // Gallery selection
                    results = new Uri[]{data.getData()};
                } else if (cameraOutputUri != null) {
                    // Camera capture — photo saved to cameraOutputUri
                    results = new Uri[]{cameraOutputUri};
                }
            }
            filePathCallback.onReceiveValue(results);
            filePathCallback = null;
            cameraOutputUri = null;
            return;
        }

        if (requestCode == SCAN_REQUEST && resultCode == RESULT_OK && data != null) {
            String url = data.getStringExtra("server_url");
            if (url != null) {
                serverUrl = url;
                getSharedPreferences(PREFS, MODE_PRIVATE)
                        .edit().putString(KEY_URL, url).apply();
                showWebView();
                return;
            }
        }
        if (serverUrl == null) finish();
        else showWebView();
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }
}

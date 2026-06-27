package pl.agroserwisnysa.serwis;

import android.content.Intent;
import android.graphics.Color;
import android.graphics.Typeface;
import android.os.Bundle;
import android.text.InputType;
import android.view.Gravity;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import androidx.appcompat.app.AppCompatActivity;
import com.google.zxing.integration.android.IntentIntegrator;
import com.google.zxing.integration.android.IntentResult;

public class ScanActivity extends AppCompatActivity {

    private EditText urlInput;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        ScrollView scroll = new ScrollView(this);
        scroll.setBackgroundColor(Color.parseColor("#f1f5f9"));

        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        layout.setPadding(56, 80, 56, 56);
        layout.setGravity(Gravity.CENTER_HORIZONTAL);
        scroll.addView(layout);

        // Icon
        TextView icon = new TextView(this);
        icon.setText("⚙");
        icon.setTextSize(52);
        icon.setGravity(Gravity.CENTER);
        layout.addView(icon);

        // Title
        TextView title = new TextView(this);
        title.setText("Agroserwis Serwis");
        title.setTextSize(22);
        title.setTypeface(null, Typeface.BOLD);
        title.setTextColor(Color.parseColor("#1e293b"));
        title.setGravity(Gravity.CENTER);
        title.setPadding(0, 16, 0, 6);
        layout.addView(title);

        TextView sub = new TextView(this);
        sub.setText("Połącz z komputerem");
        sub.setTextSize(14);
        sub.setTextColor(Color.parseColor("#64748b"));
        sub.setGravity(Gravity.CENTER);
        sub.setPadding(0, 0, 0, 40);
        layout.addView(sub);

        // QR scan button
        Button scanBtn = new Button(this);
        scanBtn.setText("📷  Zeskanuj kod QR");
        scanBtn.setBackgroundColor(Color.parseColor("#16a34a"));
        scanBtn.setTextColor(Color.WHITE);
        scanBtn.setTextSize(16);
        scanBtn.setPadding(32, 28, 32, 28);
        LinearLayout.LayoutParams scanParams = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT);
        scanBtn.setLayoutParams(scanParams);
        scanBtn.setOnClickListener(v -> startQrScan());
        layout.addView(scanBtn);

        // OR divider
        TextView or = new TextView(this);
        or.setText("— lub wpisz adres ręcznie —");
        or.setGravity(Gravity.CENTER);
        or.setPadding(0, 36, 0, 20);
        or.setTextColor(Color.parseColor("#94a3b8"));
        or.setTextSize(13);
        layout.addView(or);

        // URL hint
        TextView hint = new TextView(this);
        hint.setText("Adres serwera (z aplikacji na komputerze lub z tunelu Cloudflare):");
        hint.setTextSize(12);
        hint.setTextColor(Color.parseColor("#64748b"));
        hint.setPadding(0, 0, 0, 8);
        layout.addView(hint);

        // URL input
        urlInput = new EditText(this);
        urlInput.setHint("np. http://192.168.1.5:3737");
        urlInput.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        urlInput.setPadding(32, 28, 32, 28);
        urlInput.setBackgroundColor(Color.WHITE);
        urlInput.setTextSize(14);
        urlInput.setTextColor(Color.parseColor("#1e293b"));
        LinearLayout.LayoutParams inputParams = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT);
        inputParams.setMargins(0, 0, 0, 16);
        urlInput.setLayoutParams(inputParams);
        layout.addView(urlInput);

        // Connect button
        Button connectBtn = new Button(this);
        connectBtn.setText("Połącz");
        connectBtn.setBackgroundColor(Color.parseColor("#0f172a"));
        connectBtn.setTextColor(Color.WHITE);
        connectBtn.setTextSize(16);
        connectBtn.setPadding(32, 28, 32, 28);
        LinearLayout.LayoutParams connectParams = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT);
        connectBtn.setLayoutParams(connectParams);
        connectBtn.setOnClickListener(v -> connectManual());
        layout.addView(connectBtn);

        setContentView(scroll);
    }

    private void startQrScan() {
        IntentIntegrator integrator = new IntentIntegrator(this);
        integrator.setDesiredBarcodeFormats(IntentIntegrator.QR_CODE);
        integrator.setPrompt("Zeskanuj kod QR z aplikacji na komputerze");
        integrator.setBeepEnabled(true);
        integrator.setBarcodeImageEnabled(false);
        integrator.initiateScan();
    }

    private void connectManual() {
        String raw = urlInput.getText().toString().trim();
        if (raw.isEmpty()) {
            urlInput.setError("Wpisz adres serwera");
            return;
        }
        if (!raw.startsWith("http")) raw = "http://" + raw;
        returnUrl(raw);
    }

    private void returnUrl(String rawUrl) {
        try {
            android.net.Uri uri = android.net.Uri.parse(rawUrl);
            String mechId = uri.getQueryParameter("m");
            int port = uri.getPort();
            String base = uri.getScheme() + "://" + uri.getHost() + (port > 0 ? ":" + port : "");
            Intent intent = new Intent();
            intent.putExtra("server_url", base);
            if (mechId != null && !mechId.isEmpty()) {
                intent.putExtra("mech_id", mechId);
            }
            setResult(RESULT_OK, intent);
        } catch (Exception e) {
            Intent intent = new Intent();
            intent.putExtra("server_url", rawUrl.replaceAll("[?#].*", "").replaceAll("/+$", ""));
            setResult(RESULT_OK, intent);
        }
        finish();
    }

    @Override
    @SuppressWarnings("deprecation")
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        IntentResult result = IntentIntegrator.parseActivityResult(requestCode, resultCode, data);
        if (result != null && result.getContents() != null) {
            returnUrl(result.getContents());
        }
        // If scan cancelled, stay on this screen
    }
}

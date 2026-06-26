package pl.agroserwisnysa.serwis;

import android.content.Intent;
import android.os.Bundle;
import androidx.appcompat.app.AppCompatActivity;
import com.google.zxing.integration.android.IntentIntegrator;
import com.google.zxing.integration.android.IntentResult;

public class ScanActivity extends AppCompatActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        IntentIntegrator integrator = new IntentIntegrator(this);
        integrator.setDesiredBarcodeFormats(IntentIntegrator.QR_CODE);
        integrator.setPrompt("Zeskanuj kod QR wyświetlony w aplikacji na komputerze");
        integrator.setCameraId(0);
        integrator.setBeepEnabled(true);
        integrator.setBarcodeImageEnabled(false);
        integrator.setOrientationLocked(true);
        integrator.initiateScan();
    }

    @Override
    @SuppressWarnings("deprecation")
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        IntentResult result = IntentIntegrator.parseActivityResult(requestCode, resultCode, data);
        if (result != null && result.getContents() != null) {
            String scanned = result.getContents();
            try {
                java.net.URL url = new java.net.URL(scanned);
                int port = url.getPort();
                String baseUrl = url.getProtocol() + "://" + url.getHost() + (port > 0 ? ":" + port : "");
                Intent intent = new Intent();
                intent.putExtra("server_url", baseUrl);
                setResult(RESULT_OK, intent);
            } catch (Exception e) {
                setResult(RESULT_CANCELED);
            }
        } else {
            setResult(RESULT_CANCELED);
        }
        finish();
    }
}

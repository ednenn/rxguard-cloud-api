package com.rxguard.mobile;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.util.Base64;
import android.view.View;
import android.widget.*;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.IntentSenderRequest;
import androidx.activity.result.contract.ActivityResultContracts.StartIntentSenderForResult;
import androidx.appcompat.app.AppCompatActivity;

import com.google.android.gms.tasks.Task;
import com.google.mlkit.vision.documentscanner.GmsDocumentScanner;
import com.google.mlkit.vision.documentscanner.GmsDocumentScannerOptions;
import com.google.mlkit.vision.documentscanner.GmsDocumentScanning;
import com.google.mlkit.vision.documentscanner.GmsDocumentScanningResult;

import org.json.*;

import java.io.*;
import java.net.*;
import java.net.CookieManager;
import java.net.CookiePolicy;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.*;

import static com.google.mlkit.vision.documentscanner.GmsDocumentScannerOptions.RESULT_FORMAT_JPEG;
import static com.google.mlkit.vision.documentscanner.GmsDocumentScannerOptions.SCANNER_MODE_FULL;

public class MainActivity extends AppCompatActivity {

    private static final String BASE = "https://rxguard-standalone.onrender.com";
    private final ExecutorService io = Executors.newSingleThreadExecutor();

    private TextView serverState, scanState, resultSummary, authState, modeTitle, drugInfo;
    private LinearLayout drugRows, authBox, modeBox, appBox, pharmacistBox, infoBox;
    private final List<JSONObject> prescriptions = new ArrayList<>();
    private final List<JSONObject> reports = new ArrayList<>();
    private JSONObject activePrescription = null;
    private boolean manual = false;

    private EditText rxNo, rxDate, patientName, genderAge, hospital, doctorName, doctorBranch, icd, loginName, loginEmail, loginPassword, drugQuery;

    private final ActivityResultLauncher<IntentSenderRequest> scannerLauncher =
            registerForActivityResult(new StartIntentSenderForResult(), result -> {
                if (result.getResultCode() != Activity.RESULT_OK) {
                    scanState.setText("Tarama iptal edildi.");
                    return;
                }
                GmsDocumentScanningResult scan =
                        GmsDocumentScanningResult.fromActivityResultIntent(result.getData());
                if (scan == null || scan.getPages() == null || scan.getPages().isEmpty()) {
                    scanState.setText("Belge bulunamadı.");
                    return;
                }
                scanState.setText(scan.getPages().size() + " sayfa tarandı. Reçete ve raporlar okunuyor...");
                List<Uri> uris = new ArrayList<>();
                for (GmsDocumentScanningResult.Page p : scan.getPages()) uris.add(p.getImageUri());
                analyzePagesSequentially(uris);
            });

    @Override protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        CookieManager cm = new CookieManager();
        cm.setCookiePolicy(CookiePolicy.ACCEPT_ALL);
        CookieHandler.setDefault(cm);

        serverState = findViewById(R.id.serverState);
        authState = findViewById(R.id.authState);
        modeTitle = findViewById(R.id.modeTitle);
        drugInfo = findViewById(R.id.drugInfo);
        authBox = findViewById(R.id.authBox);
        modeBox = findViewById(R.id.modeBox);
        appBox = findViewById(R.id.appBox);
        pharmacistBox = findViewById(R.id.pharmacistBox);
        infoBox = findViewById(R.id.infoBox);
        loginName = findViewById(R.id.loginName);
        loginEmail = findViewById(R.id.loginEmail);
        loginPassword = findViewById(R.id.loginPassword);
        drugQuery = findViewById(R.id.drugQuery);

        scanState = findViewById(R.id.scanState);
        resultSummary = findViewById(R.id.resultSummary);
        drugRows = findViewById(R.id.drugRows);
        rxNo = findViewById(R.id.rxNo);
        rxDate = findViewById(R.id.rxDate);
        patientName = findViewById(R.id.patientName);
        genderAge = findViewById(R.id.genderAge);
        hospital = findViewById(R.id.hospital);
        doctorName = findViewById(R.id.doctorName);
        doctorBranch = findViewById(R.id.doctorBranch);
        icd = findViewById(R.id.icd);

        findViewById(R.id.scanButton).setOnClickListener(v -> startNativeScanner());
        findViewById(R.id.checkButton).setOnClickListener(v -> checkPrescription());
        findViewById(R.id.manualButton).setOnClickListener(v -> toggleManual());
        findViewById(R.id.loginButton).setOnClickListener(v -> auth(false));
        findViewById(R.id.registerButton).setOnClickListener(v -> auth(true));
        findViewById(R.id.logoutButton).setOnClickListener(v -> logout());
        findViewById(R.id.backModes).setOnClickListener(v -> showModes());
        findViewById(R.id.modePharmacist).setOnClickListener(v -> enterMode("eczaci"));
        findViewById(R.id.modeHealth).setOnClickListener(v -> enterMode("saglikci"));
        findViewById(R.id.modeStudent).setOnClickListener(v -> enterMode("ogrenci"));
        findViewById(R.id.modePatient).setOnClickListener(v -> enterMode("hasta"));
        findViewById(R.id.drugInfoButton).setOnClickListener(v -> loadDrugInfo());

        health();
        checkSession();
    }


    private void checkSession() {
        io.execute(() -> {
            try {
                get("/api/auth/me");
                runOnUiThread(this::showModes);
            } catch(Exception e) {
                runOnUiThread(this::showAuth);
            }
        });
    }

    private void showAuth() {
        authBox.setVisibility(View.VISIBLE);
        modeBox.setVisibility(View.GONE);
        appBox.setVisibility(View.GONE);
    }

    private void showModes() {
        authBox.setVisibility(View.GONE);
        modeBox.setVisibility(View.VISIBLE);
        appBox.setVisibility(View.GONE);
    }

    private void enterMode(String mode) {
        authBox.setVisibility(View.GONE);
        modeBox.setVisibility(View.GONE);
        appBox.setVisibility(View.VISIBLE);
        boolean pharmacist = "eczaci".equals(mode);
        pharmacistBox.setVisibility(pharmacist ? View.VISIBLE : View.GONE);
        infoBox.setVisibility(pharmacist ? View.GONE : View.VISIBLE);
        if ("eczaci".equals(mode)) modeTitle.setText("💊 Eczacı");
        else if ("saglikci".equals(mode)) modeTitle.setText("🩺 Sağlıkçı");
        else if ("ogrenci".equals(mode)) modeTitle.setText("🎓 Öğrenci");
        else modeTitle.setText("👤 Hasta");
        infoBox.setTag(mode);
    }

    private void auth(boolean register) {
        authState.setText(register ? "Kayıt yapılıyor..." : "Giriş yapılıyor...");
        io.execute(() -> {
            try {
                JSONObject b = new JSONObject();
                b.put("email", loginEmail.getText().toString().trim());
                b.put("password", loginPassword.getText().toString());
                if(register) b.put("name", loginName.getText().toString().trim());
                post(register ? "/api/auth/register" : "/api/auth/login", b);
                runOnUiThread(() -> {
                    authState.setText("Başarılı.");
                    showModes();
                });
            } catch(Exception e) {
                runOnUiThread(() -> authState.setText("HATA: " + e.getMessage()));
            }
        });
    }

    private void logout() {
        io.execute(() -> {
            try { post("/api/auth/logout", new JSONObject()); } catch(Exception ignored) {}
            runOnUiThread(this::showAuth);
        });
    }

    private void loadDrugInfo() {
        final String q = drugQuery.getText().toString().trim();
        if(q.isEmpty()) return;
        drugInfo.setText("Bilgi aranıyor...");
        io.execute(() -> {
            try {
                JSONObject d = get("/api/drug/info?q=" + URLEncoder.encode(q, "UTF-8"));
                JSONArray rs = d.optJSONArray("results");
                final String mode = String.valueOf(infoBox.getTag());
                final String text;
                if(rs == null || rs.length() == 0) text = "Kayıt bulunamadı. Ortak ilaç veritabanı daha sonra doldurulacak.";
                else {
                    String prefix = "hasta".equals(mode) ? "Kısa anlatım:\n" :
                            "ogrenci".equals(mode) ? "Ders anlatımı:\n" :
                            "saglikci".equals(mode) ? "Klinik bilgi:\n" : "";
                    text = prefix + rs.optJSONObject(0).toString(2);
                }
                runOnUiThread(() -> drugInfo.setText(text));
            } catch(Exception e) {
                runOnUiThread(() -> drugInfo.setText("HATA: " + e.getMessage()));
            }
        });
    }

    private void startNativeScanner() {
        GmsDocumentScannerOptions options = new GmsDocumentScannerOptions.Builder()
                .setGalleryImportAllowed(false)
                .setPageLimit(100)
                .setResultFormats(RESULT_FORMAT_JPEG)
                .setScannerMode(SCANNER_MODE_FULL)
                .build();

        GmsDocumentScanner scanner = GmsDocumentScanning.getClient(options);
        scanner.getStartScanIntent(this)
                .addOnSuccessListener(sender ->
                        scannerLauncher.launch(new IntentSenderRequest.Builder(sender).build()))
                .addOnFailureListener(e -> scanState.setText("Tarayıcı açılamadı: " + e.getMessage()));
    }

    private void analyzePagesSequentially(List<Uri> pages) {
        io.execute(() -> {
            int i = 0;
            for (Uri uri : pages) {
                i++;
                final int n = i;
                runOnUiThread(() -> scanState.setText("Belge " + n + "/" + pages.size() + " okunuyor..."));
                try {
                    byte[] bytes = readAll(uri);
                    String dataUrl = "data:image/jpeg;base64," +
                            Base64.encodeToString(bytes, Base64.NO_WRAP);

                    JSONObject payload = new JSONObject();
                    JSONArray imgs = new JSONArray();
                    imgs.put(dataUrl);
                    payload.put("images", imgs);

                    JSONObject response = post("/api/mobile/analyze", payload);
                    mergeAnalyze(response);
                } catch (Exception e) {
                    final String m = e.getMessage();
                    runOnUiThread(() -> scanState.setText("Bir belge okunamadı: " + m));
                }
            }

            runOnUiThread(() -> {
                if (!prescriptions.isEmpty()) {
                    activePrescription = prescriptions.get(0);
                    renderPrescription(activePrescription);
                    scanState.setText("Aktarım tamamlandı: " + prescriptions.size() +
                            " reçete, " + reports.size() + " rapor algılandı.");
                    resultSummary.setText("Reçete kontrol için hazır.");
                } else {
                    scanState.setText("Tarama tamamlandı ancak reçete algılanamadı.");
                }
            });
        });
    }

    private synchronized void mergeAnalyze(JSONObject d) throws JSONException {
        JSONArray docs = d.optJSONArray("documents");
        if (docs == null) {
            if (d.has("document")) {
                docs = new JSONArray();
                docs.put(d.getJSONObject("document"));
            } else if (d.has("prescriptions") || d.has("reports")) {
                JSONArray ps = d.optJSONArray("prescriptions");
                if (ps != null) for (int i=0;i<ps.length();i++) prescriptions.add(ps.getJSONObject(i));
                JSONArray rs = d.optJSONArray("reports");
                if (rs != null) for (int i=0;i<rs.length();i++) reports.add(rs.getJSONObject(i));
                return;
            } else return;
        }

        for (int i=0;i<docs.length();i++) {
            JSONObject x = docs.getJSONObject(i);
            String type = x.optString("type", x.optString("documentType", "")).toLowerCase(Locale.ROOT);
            if (type.contains("rapor")) reports.add(x);
            else if (type.contains("reç") || type.contains("rec") || type.contains("prescription")) prescriptions.add(x);
        }
    }

    private void renderPrescription(JSONObject p) {
        rxNo.setText(p.optString("rxNo", p.optString("prescriptionNo", "")));
        rxDate.setText(p.optString("rxDate", p.optString("date", "")));
        patientName.setText(p.optString("patientName", ""));
        String ga = p.optString("patientGender", p.optString("gender", ""));
        String age = p.optString("patientAge", p.optString("age", ""));
        if (!age.isEmpty()) ga += (ga.isEmpty() ? "" : " / ") + age;
        genderAge.setText(ga);
        hospital.setText(p.optString("hospital", p.optString("facility", "")));
        doctorName.setText(p.optString("doctorName", ""));
        doctorBranch.setText(p.optString("doctorBranch", p.optString("branch", "")));

        Object icdObj = p.opt("icd");
        if (icdObj instanceof JSONArray) {
            JSONArray a = (JSONArray) icdObj;
            List<String> vals = new ArrayList<>();
            for(int i=0;i<a.length();i++) {
                Object o = a.opt(i);
                if(o instanceof JSONObject) vals.add(((JSONObject)o).optString("code", o.toString()));
                else vals.add(String.valueOf(o));
            }
            icd.setText(String.join(", ", vals));
        } else icd.setText(p.optString("icd", ""));

        drugRows.removeAllViews();
        JSONArray drugs = p.optJSONArray("drugs");
        if (drugs == null || drugs.length()==0) {
            addDrugRow(new JSONObject());
            return;
        }
        for(int i=0;i<drugs.length();i++) addDrugRow(drugs.optJSONObject(i));
    }

    private void addDrugRow(JSONObject d) {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(12,12,12,12);
        LinearLayout.LayoutParams bp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        bp.setMargins(0,8,0,8);
        box.setLayoutParams(bp);
        box.setBackgroundColor(0xFFFFFFFF);

        TextView name = new TextView(this);
        name.setText(d.optString("name", "İlaç"));
        name.setTextSize(17);
        name.setTextColor(0xFF123B57);
        name.setTypeface(null, 1);
        box.addView(name);

        TextView detail = new TextView(this);
        String use = d.optString("usage", d.optString("dose", ""));
        String boxCount = d.optString("boxCount", "");
        String ai = d.optString("activeIngredient", "");
        detail.setText("Barkod: " + d.optString("barcode","") +
                "\nKutu: " + boxCount +
                "\nKullanım: " + use +
                (ai.isEmpty() ? "" : "\nEtken madde: " + ai));
        detail.setTextColor(0xFF3E5665);
        box.addView(detail);

        TextView status = new TextView(this);
        status.setTag("status");
        status.setText("KONTROL BEKLİYOR");
        status.setTextSize(15);
        status.setTypeface(null,1);
        status.setPadding(0,10,0,0);
        status.setTextColor(0xFF36586C);
        box.addView(status);

        box.setTag(d);
        drugRows.addView(box);
    }

    private void checkPrescription() {
        if (activePrescription == null) {
            resultSummary.setText("Önce reçete tara veya manuel reçete gir.");
            return;
        }
        resultSummary.setText("Reçete kontrol ediliyor...");
        io.execute(() -> {
            try {
                JSONObject body = new JSONObject();
                body.put("prescription", activePrescription);
                body.put("reports", new JSONArray(reports));
                JSONObject d = post("/api/prescription/check", body);
                JSONObject check = d.optJSONObject("check");
                JSONArray results = check == null ? null : check.optJSONArray("results");

                runOnUiThread(() -> {
                    if (results != null) {
                        for(int i=0;i<drugRows.getChildCount();i++) {
                            LinearLayout row = (LinearLayout) drugRows.getChildAt(i);
                            TextView s = row.findViewWithTag("status");
                            JSONObject r = i < results.length() ? results.optJSONObject(i) : null;
                            String st = r == null ? "İNCELEME" : r.optString("status","İNCELEME");
                            String reason = r == null ? "Kural sonucu alınamadı." : r.optString("reason","");
                            if ("UYGUN".equalsIgnoreCase(st)) {
                                s.setText("✓ TAMAMDIR" + (reason.isEmpty() ? "" : " — " + reason));
                                s.setTextColor(0xFF08743D);
                            } else if (st.toUpperCase(Locale.ROOT).contains("KESINTI") || st.toUpperCase(Locale.ROOT).contains("ÖDEN")) {
                                s.setText("✕ ÖDENMİYOR — " + reason);
                                s.setTextColor(0xFFA52323);
                            } else if (st.toUpperCase(Locale.ROOT).contains("TEY")) {
                                s.setText("⚠ DOKTOR TEYİDİ — " + reason);
                                s.setTextColor(0xFF8A6700);
                            } else {
                                s.setText("• İNCELENECEK — " + reason);
                                s.setTextColor(0xFF36586C);
                            }
                        }
                    }
                    String overall = check == null ? "İNCELEME" : check.optString("overall","İNCELEME");
                    resultSummary.setText("REÇETE SONUCU: " + overall);
                });
            } catch(Exception e) {
                runOnUiThread(() -> resultSummary.setText("Kontrol hatası: " + e.getMessage()));
            }
        });
    }

    private void toggleManual() {
        manual = !manual;
        for (EditText e : new EditText[]{rxNo,rxDate,patientName,genderAge,hospital,doctorName,doctorBranch,icd})
            e.setEnabled(manual);
        Toast.makeText(this, manual ? "Manuel düzenleme açık" : "Manuel düzenleme kapalı", Toast.LENGTH_SHORT).show();
    }

    private void health() {
        io.execute(() -> {
            try {
                JSONObject d = get("/api/health");
                runOnUiThread(() -> serverState.setText(d.optBoolean("ok") ?
                        "Sunucu aktif • API " + d.optString("version") : "Sunucu hatası"));
            } catch(Exception e) {
                runOnUiThread(() -> serverState.setText("Sunucuya bağlanamadı"));
            }
        });
    }

    private byte[] readAll(Uri uri) throws IOException {
        try (InputStream in = getContentResolver().openInputStream(uri);
             ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf,0,n);
            return out.toByteArray();
        }
    }

    private JSONObject get(String path) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(BASE + path).openConnection();
        c.setConnectTimeout(30000);
        c.setReadTimeout(60000);
        c.setRequestMethod("GET");
        return readResponse(c);
    }

    private JSONObject post(String path, JSONObject body) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(BASE + path).openConnection();
        c.setConnectTimeout(30000);
        c.setReadTimeout(120000);
        c.setRequestMethod("POST");
        c.setDoOutput(true);
        c.setRequestProperty("Content-Type","application/json; charset=utf-8");
        byte[] data = body.toString().getBytes(StandardCharsets.UTF_8);
        try(OutputStream out = c.getOutputStream()) { out.write(data); }
        return readResponse(c);
    }

    private JSONObject readResponse(HttpURLConnection c) throws Exception {
        int code = c.getResponseCode();
        InputStream raw = code >= 400 ? c.getErrorStream() : c.getInputStream();
        String text;
        try(BufferedReader r = new BufferedReader(new InputStreamReader(raw, StandardCharsets.UTF_8))) {
            StringBuilder b = new StringBuilder();
            String line;
            while((line=r.readLine())!=null) b.append(line);
            text = b.toString();
        }
        if(code >= 400) throw new IOException("HTTP " + code + ": " + text);
        return new JSONObject(text);
    }

    @Override protected void onDestroy() {
        super.onDestroy();
        io.shutdownNow();
    }
}
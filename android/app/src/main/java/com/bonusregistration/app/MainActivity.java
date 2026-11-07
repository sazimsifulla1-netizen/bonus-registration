package com.bonusregistration.app;

import android.app.Activity;
import android.os.Bundle;
import android.graphics.Color;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.*;
import android.widget.*;
import android.content.Intent;
import android.net.Uri;

public class MainActivity extends Activity {
    private WebView web;
    private ValueCallback<Uri[]> uploadCallback;
    private static final int FILE_PICKER = 101;
    private final String website = "https://bonus-registration.onrender.com/";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.rgb(8,8,8));

        web = new WebView(this);
        web.setBackgroundColor(Color.BLACK);
        web.getSettings().setJavaScriptEnabled(true);
        web.getSettings().setDomStorageEnabled(true);
        web.getSettings().setDatabaseEnabled(true);
        web.getSettings().setAllowFileAccess(true);
        web.getSettings().setJavaScriptCanOpenWindowsAutomatically(true);

        web.setWebViewClient(new WebViewClient());
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view,
                    ValueCallback<Uri[]> callback,
                    FileChooserParams params) {
                if (uploadCallback != null) uploadCallback.onReceiveValue(null);
                uploadCallback = callback;
                try {
                    Intent intent = params.createIntent();
                    startActivityForResult(intent, FILE_PICKER);
                    return true;
                } catch (Exception e) {
                    uploadCallback = null;
                    return false;
                }
            }
        });

        root.addView(web, new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));

        LinearLayout nav = new LinearLayout(this);
        nav.setGravity(Gravity.CENTER);
        nav.setBackgroundColor(Color.rgb(12,12,12));

        String[] labels = {"⌂\nHome", "☑\nTasks", "৳\nWallet", "●\nProfile"};
        String[] keywords = {"home", "task", "wallet", "profile"};

        for (int i = 0; i < labels.length; i++) {
            final String key = keywords[i];
            TextView item = new TextView(this);
            item.setText(labels[i]);
            item.setTextColor(Color.rgb(212,175,55));
            item.setTextSize(12);
            item.setGravity(Gravity.CENTER);
            item.setPadding(4, 12, 4, 12);
            item.setLayoutParams(new LinearLayout.LayoutParams(0,
                ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
            item.setOnClickListener(v -> {
                web.evaluateJavascript(
                    "(function(){var k='" + key + "';" +
                    "var els=document.querySelectorAll('a,button,[role=button],nav li');" +
                    "for(var i=0;i<els.length;i++){" +
                    "if((els[i].innerText||'').toLowerCase().includes(k)){" +
                    "els[i].click();return 'clicked';}}" +
                    "return 'not-found';})()", null);
                if (key.equals("home")) web.loadUrl(website);
            });
            nav.addView(item);
        }

        root.addView(nav);
        setContentView(root);
        web.loadUrl(website);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == FILE_PICKER && uploadCallback != null) {
            Uri[] results = WebChromeClient.FileChooserParams.parseResult(resultCode, data);
            uploadCallback.onReceiveValue(results);
            uploadCallback = null;
        }
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        if (uploadCallback != null) {
            uploadCallback.onReceiveValue(null);
            uploadCallback = null;
        }
        if (web != null) web.destroy();
        super.onDestroy();
    }
}

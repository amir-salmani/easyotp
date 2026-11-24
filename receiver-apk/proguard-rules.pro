# The screens call these methods by name from JavaScript, so the names must survive.
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}

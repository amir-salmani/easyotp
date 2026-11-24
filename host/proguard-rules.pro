# Keep nothing extra by default. If a rule becomes necessary, state why here --
# broad keep rules on a security-sensitive app defeat the shrinker's value.
# The screens call these methods by name from JavaScript, so the names must survive.
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}

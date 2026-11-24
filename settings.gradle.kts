// Builds run in GitHub Actions and resolve from Google and Maven Central
// directly (DECISIONS D20). There is no mirror to opt into.
pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "EasyOTP"
// host and receiver-apk are the two apps. shell is the little they share:
// a WebView that shows screens bundled inside the APK.
include(":host", ":receiver-apk", ":shell")

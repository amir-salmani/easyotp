plugins {
    alias(libs.plugins.android.application)
}

// The Receiver as an Android app: the same screens as the PWA, bundled in the
// APK and shown in a WebView (DECISIONS D19). Everything a Receiver does is in
// those screens; the native part is the window and the notifications.
android {
    namespace = "ir.rhinocloud.easyotp.receiver"
    compileSdk = 37

    defaultConfig {
        // Its own id, so a Host and a Receiver can sit on one phone. An id is
        // permanent once a phone has installed it.
        applicationId = "ir.rhinocloud.easyotp.receiver"
        minSdk = 26
        targetSdk = 36
        versionCode = System.getenv("EASYOTP_VERSION_CODE")?.toIntOrNull() ?: 1
        versionName = System.getenv("EASYOTP_VERSION_NAME") ?: "0.1.0-dev"
    }

    // The same release key as the Host, and the same rule: without it a
    // release build is left unsigned (DECISIONS D20).
    val releaseKeystore = System.getenv("EASYOTP_KEYSTORE")
    signingConfigs {
        if (releaseKeystore != null) {
            create("release") {
                storeFile = file(releaseKeystore)
                storeType = "pkcs12"
                storePassword = System.getenv("EASYOTP_KEYSTORE_PASSWORD")
                keyAlias = "easyotp"
                keyPassword = System.getenv("EASYOTP_KEYSTORE_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            signingConfig = signingConfigs.findByName("release")
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    implementation(project(":shell"))
}

// The screens are built from receiver/ and are not in git. An APK without them
// would install and show a blank window, so the build stops here instead.
run {
    // Locals only: a task action that reaches for the build script cannot be cached.
    val screens = layout.projectDirectory.file("src/main/assets/app/index.html").asFile
    val missing = "The screens are missing. Run `npm run build:apk` in receiver/ first."
    tasks.named("preBuild") {
        doFirst {
            if (!screens.exists()) throw GradleException(missing)
        }
    }
}

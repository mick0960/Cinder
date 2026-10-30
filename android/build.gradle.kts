plugins {
    alias(libs.plugins.android.application) apply false
    // AGP 9 内置 Kotlin 支持；这里声明版本让内置 Kotlin 使用与 compose / serialization 插件一致的 KGP
    alias(libs.plugins.kotlin.android) apply false
    alias(libs.plugins.kotlin.compose) apply false
    alias(libs.plugins.kotlin.serialization) apply false
}

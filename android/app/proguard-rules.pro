# QuickJS 的原生代码经 JNI 按名字回调绑定接口；库自带规则只覆盖了部分类，整包保留（约 190 KB）
-keep class com.dokar.quickjs.** { *; }

# Shizuku 按类名在 shell 进程里反射创建 UserService，构造函数必须保留
-keep class com.cinder.mobile.shizuku.PrivilegedService { <init>(...); }
-keep class com.cinder.mobile.shizuku.IPrivileged** { *; }

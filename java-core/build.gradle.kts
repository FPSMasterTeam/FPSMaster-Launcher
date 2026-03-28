plugins {
    application
}

group = "com.fpsmaster"
version = "0.1.0"

java {
    toolchain {
        languageVersion.set(JavaLanguageVersion.of(17))
    }
}

repositories {
    mavenCentral()
}

dependencies {
    implementation("com.google.code.gson:gson:2.11.0")
    testImplementation(platform("org.junit:junit-bom:5.10.2"))
    testImplementation("org.junit.jupiter:junit-jupiter")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

application {
    mainClass.set("com.fpsmaster.launcher.core.LauncherCoreCli")
}

tasks.withType<JavaCompile> {
    options.encoding = "UTF-8"
}

tasks.jar {
    manifest {
        attributes["Main-Class"] = "com.fpsmaster.launcher.core.LauncherCoreCli"
    }
}

val fatJar by tasks.registering(Jar::class) {
    archiveClassifier.set("all")
    manifest {
        attributes["Main-Class"] = "com.fpsmaster.launcher.core.LauncherCoreCli"
    }
    duplicatesStrategy = DuplicatesStrategy.EXCLUDE
    from(sourceSets.main.get().output)
    dependsOn(configurations.runtimeClasspath)
    from({
        configurations.runtimeClasspath.get().filter { it.name.endsWith("jar") }.map { zipTree(it) }
    })
}

tasks.build {
    dependsOn(fatJar)
}

tasks.test {
    useJUnitPlatform()
}

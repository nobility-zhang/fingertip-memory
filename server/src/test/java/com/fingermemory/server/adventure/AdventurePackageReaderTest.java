package com.fingermemory.server.adventure;

import static org.assertj.core.api.Assertions.assertThat;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import tools.jackson.databind.ObjectMapper;

class AdventurePackageReaderTest {
    @TempDir
    Path packageRoot;

    @Test
    void preservesCostumePortraitPathsFromCharacterDefinitions() throws Exception {
        write("manifest.json", """
                {"schemaVersion":1,"namespace":"fm.demo","bookId":"windmill-post",
                 "contentVersion":"1.1.0","title":"风车邮路",
                 "engineRange":{"minInclusive":"0.3.0","maxExclusive":"0.4.0"},
                 "entryNodeId":"windmill.meet","seriesId":"windmill-post",
                 "capabilities":["card-battle-v1"],"requires":[
                   {"bookId":"warm-lantern","endingId":"main",
                    "endingTitle":"主线结局",
                    "minContentVersion":"1.0.0"}
                 ]}
                """);
        write("story.json", """
                {"chapters":[{"chapterId":"windmill-post-chapter","title":"风车邮路",
                  "nodes":[{"nodeId":"windmill.meet","type":"dialogue",
                    "portraitCharacterId":"nora","costumeId":"wind-courier",
                    "sceneId":"windmill-road","endingId":"station-keeper",
                    "endingTitle":"邮站留灯",
                    "inheritedFlags":["encounter.windmill-post-warden.resolved"]}]}]}
                """);
        write(
                "vocabulary.tsv",
                "wordKey\tterm\tmeaning\tacceptedAnswers\thints\n"
                        + "wind\twind\t风\t\"[\"\"wind\"\"]\"\t\"[]\"\n");
        write("cards.json", "{\"cards\":[]}");
        write("encounters.json", "{\"encounters\":[]}");
        write("characters.json", """
                {"characters":[{"characterKey":"nora","name":"诺拉",
                  "definitionVersion":"1.0.0","age":15,"availability":"companion",
                  "defaultCostumeId":"wind-courier",
                  "costumes":{"wind-courier":{
                    "neutral":"assets/characters/nora/wind-courier/neutral.png",
                    "cheer":"assets/characters/nora/wind-courier/cheer.png"}},
                  "dialogue":{"welcome":"欢迎","again":"再来","rest":"休息",
                    "training":"练习","practice":"复习","result":"完成"},
                  "skill":{"name":"顺风投递","description":"造成伤害",
                    "type":"damage","amount":6}}]}
                """);
        write("scenes.json", """
                {"scenes":[{"sceneId":"windmill-road","name":"风车邮路",
                  "background":"assets/scenes/windmill-road.jpg"}]}
                """);

        AdventurePackageReader.AdventurePackage content =
                new AdventurePackageReader(new ObjectMapper()).read(packageRoot);

        assertThat(content.characters().get("nora").costumes()
                .get("wind-courier").get("cheer"))
                .isEqualTo("assets/characters/nora/wind-courier/cheer.png");
        assertThat(content.scenes().get("windmill-road").background())
                .isEqualTo("assets/scenes/windmill-road.jpg");
        assertThat(content.seriesId()).isEqualTo("windmill-post");
        assertThat(content.requirements()).singleElement()
                .satisfies(requirement -> {
                    assertThat(requirement.bookId()).isEqualTo("warm-lantern");
                    assertThat(requirement.endingId()).isEqualTo("main");
                });
        assertThat(content.nodes().get("windmill.meet").endingId())
                .isEqualTo("station-keeper");
        assertThat(content.nodes().get("windmill.meet").inheritedFlags())
                .containsExactly("encounter.windmill-post-warden.resolved");
    }

    @Test
    void readsDialogueStageCuesAndOpeningRouteModifiers() throws Exception {
        write("manifest.json", """
                {"schemaVersion":1,"namespace":"fm.demo","bookId":"warm-lantern",
                 "contentVersion":"4.0.0","title":"暖灯与失语之森",
                 "engineRange":{"minInclusive":"0.3.0","maxExclusive":"0.4.0"},
                 "entryNodeId":"inn.arrival","seriesId":"warm-lantern",
                 "capabilities":["card-battle-v1"],"requires":[]}
                """);
        write("story.json", """
                {"chapters":[{"chapterId":"chapter-1","title":"暖灯与失语之森",
                  "nodes":[
                    {"nodeId":"inn.arrival","type":"choice","title":"暖灯旅店",
                     "sceneId":"inn-warm-lantern",
                     "lines":[
                       {"lineId":"c1-window-002","speaker":"serin",
                        "portraitCharacterId":"serin",
                        "text":"第三截绳子，拉一下就断。",
                        "stage":{"sceneId":"inn-warm-lantern","lia":"right",
                                         "serin":"left","prop":"red-string"}}],
                     "choices":[{"choiceId":"keep-lamp","label":"把灯留在窗边",
                                "targetNodeId":"bridge.guardian"}]},
                    {"nodeId":"bridge.guardian","type":"encounter",
                     "title":"雾中溪桥","text":"桥雾聚成守卫。",
                     "sceneId":"bridge-guardian",
                     "encounterId":"bridge-guardian",
                     "victoryNodeId":"bridge.guardian",
                     "rescueNodeId":"bridge.guardian",
                     "openingModifiers":{
                       "keep-lamp":{"route":"keep-lamp",
                                    "type":"block-first-turn","amount":5}}}
                  ]}]}
                """);
        write(
                "vocabulary.tsv",
                "wordKey\tterm\tmeaning\tacceptedAnswers\thints\n"
                        + "lantern\tlantern\t提灯\t\"[\"\"lantern\"\"]\"\t\"[]\"\n");
        write("cards.json", "{\"cards\":[]}");
        write("encounters.json", """
                {"encounters":[{"encounterId":"bridge-guardian",
                  "battleRulesVersion":"card-battle-v1","rewardCardIds":[]}]}
                """);
        write("characters.json", "{\"characters\":[]}");

        AdventurePackageReader.AdventurePackage content =
                new AdventurePackageReader(new ObjectMapper()).read(packageRoot);

        AdventurePackageReader.AdventureLine line = content.nodes()
                .get("inn.arrival").lines().get(0);
        assertThat(line.lineId()).isEqualTo("c1-window-002");
        assertThat(line.serin()).isEqualTo("left");
        assertThat(line.prop()).isEqualTo("red-string");
        assertThat(content.nodes().get("bridge.guardian")
                .openingModifiers().get("keep-lamp").type())
                .isEqualTo("block-first-turn");
    }

    private void write(String name, String value) throws Exception {
        Files.writeString(
                packageRoot.resolve(name),
                value,
                StandardCharsets.UTF_8);
    }
}

## Business Zadání v češtině

Aplikace bude složená z několik částí
1) observabilita = aplikace bude přijímat a vizualizovat data od uživatele v opentelemetry formátu. Konkrétně:
- log
- metric
- trace
Všechny 3 entity bude jednak ukládat do databáze. Bude podporovat http/proto a grpc/proto + json. 
Dále bude poskytovat public rest API pro snadné čtení dat a napojení na custom aplikace.
Bude podporovat sessions = spojování více traces do jedné “konverzace“.
Bude podporovat custom ID a dokonce vynucovat. Aby se daly data vždy dohledat podle tohoto idčka uživatele (traceId/logId se generuje automaticky na serveru, takže se podle něj pak v aplikaci nedá trace hned pullovat. Přes custom Idčko ano).
Součástí bude UIko, které bude entity vizualizovat:
- trace = bude se inspirovat mlflow
- log = bude se inspirovat logly
- metric = bude se inspirovat prometheus / grafana

2) evaluace
- Uživatel si nadefinuje datové sety, kde bude sada testů. 
- 1 test může buď testovat různý scope:
    - 1 provolání aplikace (1 test = 1 trace)  
    - nebo celý session. => Pak se vyhodnocují všechny traces v rámci session dohromady, zda se splnil daný cíl.
- Každý test se pak bude vyhodnocovat a to několika způsoby (a to na obou úrovních trace test / session test):
    - grading test = výsledek výhodnocuje LLM (uživatel dodá 1, čí více promptů) => llm as a judge
    - regex test = výsledek se vyhodnocuje jako string
    - telemetry test = vyhodnocují se jednotlivé spany. (například - byl zavolán tool? / Zavolalo se llm s touto verzí?)
- Každý test se bude spouštět x krát (tohle musí být konfigurovatelné). 
- Na konci evaluace udělá LLM Summary celého běhu. Bude default prompt, ale uživatel bude moci nadefinovat vlastní
- Výsledky evaluací se budou ukládat do databáze
- Reporting: Možnost posílat reporty na email / do teams. 
- Vše bude vizualizováno ve stejném UI jako observabilita
- součást bude veřejné API, aby si mohl uživatel snadno napojit eval features do vlastní aplikace. Popřípadě napojit vlastní evaluační script v jiném programovacím jazyce
- možnost napojení na různé llm providery (včetně moderních jako je https://typesafe.ai/). 

3) prompty 
- aplikace bude ukládat prompty. 
- Každý prompt bude mít verze. Verze se budou dát mezi sebou porovnávat
- Bude součástí public API, aby si uživatel mohl snadno uložit do aplikace. 

4) uživatelé a skupiny
- ruzní uživatelů budou partřit do skupin a ty budou mít různá oprávnění
- TODO: definovat rozsah oprávnění
- musíme mít možnost importovat tyhle data. Korporáty už mají svoje seznamy uživatelů / skupin / práv. 

Devops:
- aplikace bude production ready s možností škálovat
    - evaluace jako async joby + ui + Otel BE + Eval BE
    - možnost nasadit on-prem (openshift) / cloud (azure/aws).
- pro rychlý onboarding bude existovat 1 simple docker image bez závislostí, který si člověk bude moci snadno spustit lokálně. Takže všechno uložené v sqllite!!!!!

Agentic coding:
- nadefinovat cloude.md, glossary.md
- aplikace bude pokrytá testy, které se budou spouštět v github pipeline 
    - unit testy
    - e2e testy
    - performance testy
    - linter
- aplikace bude mít dokumentaci. Readme + examples folder kde budou jednotlivé scénáře.

Jazyk
Veškerý kód, dokumentace, testy, examply, ops bude v angličtině

Technické provedení (architektura)
- veškerý kód bude jedno velké monorepo
- programovací jazyk https://deno.com/ + typescript
- uložiště = navrhuji vše ukládat do MongoDB. Používat ORM kvůli fallbacku na sqlite. 
- dlouhotrvající joby = bullMQ? 
- docker
- github pipelines

Piš čistý a modulání kód
- odděluj logické části kódu do modulů, ať se pak můžou snadno vymetit / refaktorovat
- struktura projektů i samotný kód musí být snadno čitelný pro programátora
- důkladně pojmenovávej soubory / funkce / proměnné a další věci. Ať jde z názvu vyčíst účel. Žádné jednoznakové názvy!
- ! Než začneš projekt vytvářet, tak si spolu schválíme návrh struktury repa !

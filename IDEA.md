Koncepcja platformy SaaS dla rejestru serwerów MCP (Model Context Provider)

Wprowadzenie

Model Context Protocol (MCP) to otwarty standard definiujący, w jaki sposób modele językowe i agenci AI mogą odnajdować, łączyć i wykorzystywać zewnętrzne narzędzia oraz źródła danych ￼. Został on zaprezentowany pod koniec 2024 roku przez firmę Anthropic jako uniwersalny „most” łączący modele AI z danymi i usługami ze świata zewnętrznego ￼ ￼. MCP umożliwia dwukierunkową komunikację między asystentem AI (klient MCP) a zewnętrznym serwerem dostarczającym kontekst lub funkcjonalność (serwer MCP) ￼. Dzięki temu nawet duże modele językowe mogą dynamicznie rozszerzać swoje możliwości – od wykonywania obliczeń czy wywoływania API, po dostęp do baz wiedzy i aplikacji biznesowych – bez konieczności każdorazowego tworzenia niestandardowych integracji. Standard MCP zyskuje obecnie na popularności i ma szansę stać się „USB-C świata AI” – uniwersalnym interfejsem dla narzędzi AI ￼.

Wraz z rosnącą adopcją MCP (obsługa pojawia się m.in. w produktach OpenAI, Google, AWS oraz w frameworkach agentowych takich jak CrewAI czy LangGraph ￼), powstaje bogaty ekosystem zewnętrznych serwerów MCP dostarczających rozmaite narzędzia typu tool (kalkulatory, usługi pogodowe, wyszukiwarki, bazy danych itp.). Już teraz społeczność udostępniła tysiące takich serwerów ￼. Brakuje jednak scentralizowanego miejsca ich odkrywania i weryfikacji – odpowiednika „marketplace” dla narzędzi AI. W odpowiedzi na tę potrzebę proponujemy koncepcję platformy SaaS pełniącej rolę rejestru/marketplace serwerów MCP. Platforma ta ma umożliwić łatwą rejestrację nowych narzędzi przez twórców oraz automatyczne wyszukiwanie i podłączanie tych narzędzi przez agentów AI, zgodnie z założeniami protokołu MCP. Poniżej przedstawiamy szczegółową koncepcję takiej platformy, uwzględniając aktualny stan MCP, proponowane standardy, przyszłą integrację z agentami LLM oraz wymagane formaty danych i interfejsy API.

Przegląd Model Context Protocol (MCP) i ekosystemu narzędzi

Model Context Protocol został zaprojektowany jako otwarty, model-agnostyczny standard integracji AI z zewnętrznymi narzędziami i danymi ￼. Jest wspierany przez ważnych graczy w branży (Anthropic i in.), dzięki czemu z MCP mogą korzystać różne modele (np. Claude, GPT-4, open-source LLM) oraz dowolni dostawcy usług bez konieczności uzyskiwania czyjejkolwiek zgody ￼. MCP definiuje role: klienta MCP (np. aplikacja AI lub agent LLM) oraz serwera MCP (usługa zewnętrzna udostępniająca pewne funkcje lub dane). Serwer MCP może udostępniać trzy główne rodzaje zasobów (tzw. prymitywów) ￼:
	•	Tools (narzędzia) – aktywne funkcjonalności, które agent może wywołać w celu wykonania pewnej akcji (np. wysłanie e-maila, dodanie wydarzenia do kalendarza, modyfikacja bazy danych). Takie operacje mogą mieć skutki uboczne w świecie zewnętrznym.
	•	Resources (zasoby) – operacje dostarczające danych bez efektów ubocznych, np. zapytanie o pogodę, wyszukanie informacji w dokumentach, odczytanie zawartości pliku. Są analogiczne do narzędzi, ale służą wyłącznie pozyskiwaniu informacji.
	•	Prompts (szablony/promy) – predefiniowane podpowiedzi lub konteksty, które serwer może dostarczyć modelowi, by ułatwić mu realizację zadania (np. gotowe szablony zapytań, uzupełnienia kontekstu).

Standaryzacja MCP obejmuje sposób, w jaki serwer opisuje dostępne funkcje (np. ich nazwy, parametry, opisy działania) oraz format komunikacji z klientem. Komunikacja ta jest dwukierunkowa i interaktywna, co odróżnia MCP od prostych, jednorazowych wywołań API znanych z tradycyjnych pluginów – agent może prowadzić z narzędziem dialog, przekazywać dane wejściowe i otrzymywać wieloetapowe odpowiedzi, np. strumieniowo ￼ ￼. W najnowszej wersji specyfikacji (wiosna 2025) protokół wprowadził m.in. obsługę OAuth 2.0 (do autoryzacji dostępu), mechanizm strumieniowania odpowiedzi oraz transport oparty o HTTP (MCP może działać jako serwer HTTP) ￼. Użycie powszechnych technologii webowych ułatwia integrowanie serwerów MCP niezależnie od języka programowania czy środowiska.

Dynamiczne odkrywanie narzędzi jest kluczową cechą MCP. Agent wyposażony w klienta MCP może automatycznie wykrywać dostępne serwery i dostosowywać się do nowych możliwości bez zmian w kodzie po stronie dewelopera ￼. Dla porównania – we frameworkach typu LangChain wcześniej należało ręcznie zaimplementować klasę narzędzia w kodzie, podczas gdy MCP przenosi standaryzację na poziom protokołu komunikacyjnego z modelem. Dzięki temu to sam model/agent może „zorientować się” w nowych narzędziach i z nich korzystać, jeżeli tylko ma adres serwera i uprawnienia ￼.

Aktualny stan MCP: Po początkowym ogłoszeniu standardu (listopad 2024) społeczność AI początkowo podchodziła sceptycznie, ale w ciągu kilku miesięcy MCP zyskał ogromną trakcję. W pierwszym kwartale 2025 dostępnych były dziesiątki tysięcy implementacji serwerów MCP różnych dostawców ￼, a protokół zaczęły wspierać najważniejsze platformy AI (OpenAI, Google, AWS, Microsoft) widząc w nim konieczny element interoperacyjności ￼. Dla przykładu, Google w swoim frameworku Agent Toolkits udostępnił obsługę MCP (oraz pokrewny protokół Agent-to-Agent A2A do komunikacji między agentami), zaś Anthropic zintegrował MCP z modelem Claude i aplikacjami klienckimi (Claude Desktop) ￼. Frameworki agentowe nowej generacji – takie jak wspomniane CrewAI czy LangGraph – również implementują MCP jako natywny sposób dodawania narzędzi agentom ￼. Pojawiły się też alternatywne lub komplementarne propozycje standardów: np. Google A2A (Agent-to-Agent) służy do komunikacji między agentami (uzupełniając MCP, który łączy agentów z narzędziami) ￼, a IBM zaproponował Agent Communication Protocol (ACP) do wymiany kontekstu między agentami ￼. Te inicjatywy wskazują, że standardy dla agentów są w fazie kształtowania – jednak MCP jest powszechnie uznawany za praktyczne interim rozwiązanie dla dostępu do narzędzi ￼.

W efekcie gwałtownego rozwoju ekosystemu MCP, różnorodność dostępnych narzędzi rośnie z dnia na dzień. Antropic utrzymuje oficjalne repozytorium z przykładowymi serwerami (Google Drive, Slack, GitHub, bazy danych itd.) ￼ ￼, a społeczność dodaje kolejne integracje – od usług pogodowych, poprzez kalkulatory, po zaawansowane narzędzia analityczne. Powstało już kilka niezależnych katalogów zbierających informacje o dostępnych serwerach MCP. Przykładowo, smithery.ai, Glama.ai czy mcp.so deklarują po kilka tysięcy zarejestrowanych serwerów ￼. To pokazuje zapotrzebowanie na scentralizowany rejestr. Oficjalna mapa drogowa MCP również przewiduje stworzenie oficjalnego rejestru serwerów (podobnego do Docker Hub) z funkcjami wersjonowania, weryfikacji, sum kontrolnych i certyfikacji dostępnych narzędzi ￼. Docelowo standaryzacja rejestru ma ułatwić zarówno dostawcom, jak i użytkownikom narzędzi bezpieczne korzystanie z ekosystemu MCP.

Podsumowując, MCP dostarcza solidne podstawy techniczne do uniwersalnego katalogu narzędzi AI. Platforma, którą projektujemy, wpisuje się w ten trend – ma być SaaS-owym rejestrem MCP, ułatwiającym rozwój i wykorzystanie całego wachlarza narzędzi typu MCP tools.

Cel i zakres platformy – rejestr/marketplace dla MCP tools

Proponowana platforma SaaS ma pełnić rolę neutralnego rejestru i marketplace dla serwerów MCP, w szczególności typu tools (narzędzia dla agentów). Głównym celem jest agregowanie informacji o dostępnych narzędziach MCP i udostępnianie ich metadanych zarówno dla ludzi (developerów, użytkowników biznesowych) jak i bezpośrednio dla agentów AI. Bardzo istotne jest, że platforma nie będzie pośredniczyć w wykonaniu właściwych operacji przez narzędzia – nie przechowuje ani nie uruchamia kodu narzędzi, nie routuje wywołań w czasie rzeczywistym. Zamiast tego działa jak „spis treści” czy katalog usług, zapewniając, że agenci mogą odnaleźć potrzebne funkcje, a twórcy narzędzi – wypromować swoje usługi w standardowy sposób.

Zakres funkcjonalny platformy można podsumować następująco:
	•	Rejestracja narzędzi przez dostawców (twórców MCP) – platforma umożliwi deweloperom zewnętrznym rejestrowanie swoich serwerów MCP w katalogu. Rejestracja będzie polegać na podaniu podstawowych informacji (metadanych) o usłudze oraz endpointu zgodnego z MCP. Ważne: platforma nie hostuje tych usług – serwery MCP pozostają na infrastrukturze dostawców. Rejestracja ma charakter deklaratywny: twórca ogłasza „mój serwer MCP jest dostępny pod tym adresem i oferuje takie a takie funkcje”. Dzięki temu nawet niezależni twórcy narzędzi (np. udostępniający własne API pogodowe czy bazę wiedzy) mogą zaistnieć w ekosystemie MCP bez potrzeby budowania własnej społeczności użytkowników. Platforma będzie zachęcać do korzystania ze standaryzowanego formatu opisu – np. JSON zawierającego nazwę usługi, opis, kategorię, listę tagów, docelowe modele lub języki, wymagania dostępu (np. klucz API) itp. By ułatwić dodawanie wpisów, planowane jest wystawienie prostego REST API do rejestracji oraz narzędzia wiersza poleceń (CLI), które automatycznie wyślą zgłoszenie. Dzięki temu proces automatycznej rejestracji będzie możliwy – np. twórca, publikując nowy serwer MCP, może w swoim skrypcie wdrożeniowym od razu zarejestrować go w platformie poprzez API. Rozważane jest również opcjonalne pobieranie metadanych bezpośrednio z serwera MCP – jeżeli specyfikacja MCP przewiduje endpoint do ujawniania swoich możliwości (listy narzędzi i parametrów), platforma mogłaby przy rejestracji wykonać ping do serwera w celu zweryfikowania i uzupełnienia informacji (np. automatycznie zaciągnąć listę dostępnych akcji).
	•	Wyszukiwanie i filtrowanie narzędzi – platforma udostępni rozbudowane możliwości przeszukiwania katalogu, tak aby agent LLM lub inny klient mógł znaleźć narzędzie spełniające określone kryteria. Filtry obejmą m.in.: kategorię funkcjonalną (np. „pogoda”, „obliczenia matematyczne”, „CRM”, „bazodanowe”), tagi opisujące cechy lub branżę (np. „finanse”, „open-source”, „eksperymentalne”), język (jeśli narzędzie jest powiązane z danym językiem naturalnym lub programowania), koszt/warunki użycia (np. „free-tier”, „wymaga płatnej subskrypcji”, „pay-per-use”) oraz oceny użytkowników. Wyszukiwanie będzie dostępne zarówno poprzez interfejs użytkownika (portal webowy z listą i filtrami), jak i przez API – co ważne w kontekście integracji z agentami. Przykładowo, agent AI mógłby poprzez odpowiednie wywołanie API zapytać platformę: „znajdź dostępny serwer MCP oferujący funkcję tłumaczenia językowego z polskiego na chiński”. Platforma przeszuka metadane (opisy narzędzi, deklarowane funkcje) i zwróci listę pasujących usług wraz z ich endpointami i parametrami dostępu.
	•	Rejestracja narzędzia do kontekstu agenta (przez API) – gdy agent wybierze z katalogu odpowiednie narzędzie, musi móc automatycznie włączyć je do swojego środowiska. W architekturze MCP zwykle oznacza to, że klient MCP (aplikacja lub framework, w którym działa agent) musi zarejestrować adres serwera MCP i ewentualnie uzyskać do niego autoryzację. Platforma wesprze ten proces przez udostępnienie prostego endpointu do pobrania szczegółów i finalizacji rejestracji. Możliwe dwa podejścia, w zależności od standardów:
	1.	Przekierowanie do klienta MCP – platforma zwraca agentowi strukturę danych zgodną ze specyfikacją MCP (np. plik konfiguracyjny lub komendę), którą następnie agent przekazuje do swojego klienta MCP. Np. agent otrzyma informację: { “register”: “<adres_serwera>”, “capabilities”: […] }, po czym wywoła wewnętrznie odpowiednią metodę MCP SDK, aby dodać ten serwer.
	2.	Bezpośrednie API w agencie – alternatywnie, jeżeli środowisko agenta (framework) wystawia API np. POST /agents/{id}/mcp_servers, platforma mogłaby nawet zainicjować taką rejestrację bezpośrednio (to wymaga jednak, by agent udostępnił klucz lub mechanizm autoryzacji).
Zakładamy, że agenci korzystający z MCP będą wyposażeni w mechanizmy rejestrowania nowych serwerów w trakcie działania – i faktycznie takie rozwiązania są planowane. W specyfikacji MCP pojawia się koncepcja discovery w konfiguracji klienta (podanie listy katalogów, które agent przeszukuje) ￼. Nasza platforma może być jednym z takich katalogów. Ponadto twórcy frameworków (CrewAI, LangGraph, AutoGPT) przewidują w przyszłości standardowe endpointy discovery, które agent może zapytać dynamicznie. Projektowana platforma będzie zgodna z tymi nadchodzącymi specyfikacjami – tj. udostępni standaryzowany interfejs zapytań o narzędzia (np. REST API zgodne ze strukturą zapytań przyjętą w CrewAI czy AutoGPT). Dzięki temu agent nie tylko znajdzie narzędzie, ale i zautomatyzuje proces jego dołączenia do własnego kontekstu, bez udziału człowieka. W efekcie, w pełni autonomiczny agent mógłby w trakcie realizacji zadania samodzielnie stwierdzić brakującą umiejętność, wyszukać odpowiedni MCP tool w rejestrze, zarejestrować go i następnie użyć – wszystko to zgodnie z politykami bezpieczeństwa określonymi przez użytkownika.
	•	Brak pośredniczenia w komunikacji wykonawczej – ważnym założeniem jest, że po wyszukaniu i rejestracji narzędzia rola platformy się kończy. Agent komunikuje się z serwerem MCP bezpośrednio, używając protokołu MCP. Platforma działa tylko jako dostawca metadanych (adresu, opisu, ew. informacji autoryzacyjnych). Nie będzie więc żadnych wąskich gardeł ani opóźnień ze strony rejestru podczas wykonywania akcji – agent łączy się z narzędziem point-to-point. Taka architektura przypomina katalog usług np. z microservice’ów: platforma dostarcza Discovery i Directory Service, ale nie jest proxy ruchu. Zwiększa to niezawodność i bezpieczeństwo (mniej komponentów pośrednich), choć stawia wyzwania przed twórcami narzędzi, by zapewnić dostępność swoich serwerów. Platforma może jednak wspomagać monitorowanie statusu – np. okresowo pingować zarejestrowane endpointy i aktualizować ich status (online/offline, średni czas odpowiedzi). W katalogu narzędzia mogą mieć więc wskaźnik Online (dostępny w ostatnich X minutach) lub Offline (brak odpowiedzi), co pomoże agentom wybierać tylko dostępne usługi. Dodatkowo można pokazywać informacje o wersji protokołu MCP obsługiwanej przez serwer oraz datę ostatniego sprawdzenia.
	•	Skupienie na narzędziach typu tools – platforma w pierwszej kolejności koncentruje się na narzędziach sensu stricto, czyli funkcjach, które agenci mogą wykorzystywać do wykonywania zadań. Obejmuje to również narzędzia dostarczające danych (w terminologii MCP: Resources), bo z perspektywy agenta sposób użycia jest podobny (wywołanie funkcji). Nie planujemy natomiast katalogowania samych Prompts czy innych bardziej abstrakcyjnych zasobów kontekstowych w pierwszej wersji – choć być może w przyszłości, jeśli standard MCP to ujednolici, platforma może rozszerzyć się o sekcję np. gotowych prompt packages. Głównym profilem pozostają jednak usługi typu: „zapewnij funkcjonalność X” (np. wyszukaj informacje w sieci, przetłumacz tekst, wykonaj obliczenia matematyczne, odczytaj plik z Google Drive itp.). Takie podejście zbieżne jest z zapotrzebowaniem rynku – większość katalogów MCP tworzonych społecznie skupia się na narzędziach-akcjach, bo to one bezpośrednio zwiększają możliwości agentów.
	•	Tagi, kategorie i oceny – aby ułatwić nawigację po tysiącach dostępnych narzędzi, platforma będzie wykorzystywać system tagów i kategorii przypisanych do każdej pozycji. Twórcy przy rejestracji mogą wskazać tagi opisujące narzędzie (np. “weather”, “calendar”, “AWS”, “SQL”, “PDF”), a moderatorzy platformy lub społeczność mogą je uzupełniać. Z czasem, na podstawie użycia, mogą wyłonić się popularne kategorie. Ponadto przewidujemy mechanizm ocen i opinii – zarejestrowani użytkownicy (np. deweloperzy testujący dane narzędzie ze swoim agentem) mogą wystawić oceny (np. gwiazdkowe) oraz krótkie recenzje. Oceny będą widoczne w wynikach wyszukiwania, co pomoże wybrać sprawdzone rozwiązania. Dodatkowo zweryfikowane integracje (np. narzędzia oficjalne od znanych dostawców, albo przetestowane przez zespół platformy) mogą mieć specjalny znaczek zaufania lub certyfikacji – analogicznie do zweryfikowanych wydawców w sklepach z aplikacjami. To ważne, bo jednym z wyzwań jest zaufanie do narzędzia: agent wykonujący akcje na zewnątrz potencjalnie może narazić użytkownika na błędy lub nadużycia, stąd przydatna będzie informacja, że np. narzędzie przeszło testy bezpieczeństwa albo pochodzi od renomowanej firmy (funkcja certyfikacji planowana jest również w oficjalnym rejestrze MCP wg roadmapy ￼).
	•	Informacje o kosztach i warunkach – platforma będzie umożliwiać podanie przez dostawcę informacji o modelu kosztowym narzędzia. Ponieważ nie zakładamy obsługi płatności wewnątrz platformy, informacje te mają charakter deklaratywny i informacyjny. Przykładowo, przy narzędziu może być oznaczenie: “darmowe do 1000 zapytań miesięcznie, potem płatne”, “wymagany klucz API (wydawany po rejestracji na stronie X)”, “koszt: $0.001 per zapytanie”, itp. Agent przed użyciem takiego narzędzia może (poprzez użytkownika) zdecydować, czy je aktywować. Rozliczenia jednak odbywają się poza platformą – tzn. jeśli narzędzie wymaga klucza API, użytkownik musi go uzyskać od dostawcy i skonfigurować w swoim agencie (platforma może w tym pomóc poprzez przekazanie linku do strony rejestracji lub instrukcji). Jeżeli narzędzie działa w modelu płatności za użycie bezpośrednio (np. odczytuje zlecenia i wystawia faktury), to jest to całkowicie między użytkownikiem a dostawcą MCP. Nasza platforma nie pośredniczy w płatnościach, nie przechowuje danych finansowych – ogranicza się do roli informacyjnej (wskazanie kosztów) i ewentualnie do filtrowania (np. użytkownik może szukać tylko narzędzi oznaczonych jako „free” lub „open-source”). Takie podejście minimalizuje złożoność i ryzyko – platforma nie staje się operatorem płatności, co było poza zakresem założeń.
	•	Integracja z ekosystemem agentów (discovery endpoint) – aby platforma rzeczywiście spełniała swoją rolę w autonomicznym ekosystemie AI, musi być łatwo dostępna dla agentów i frameworków, nie tylko dla ludzi. W tym celu planujemy wdrożyć standaryzowany endpoint do odkrywania narzędzi (discovery API), zgodny z wytycznymi pojawiającymi się w społeczności agentowej. Wspomniane projekty jak CrewAI czy LangGraph dyskutują formaty zapytań, by agent mógł np. poprzez jedną komendę zdobyć listę dostępnych narzędzi z określonej kategorii. Być może zostanie ustalony jakiś uniwersalny protokół zapytań do katalogów – nasza platforma będzie zgodna z nim, o ile tylko pojawi się konsensus. Przykładowo, CrewAI może oczekiwać, że katalog z narzędziami odpowie na zapytanie HTTP GET /mcp-directory/search?tool=weather&lang=pl zwracając listę w ustalonym formacie JSON. Albo AutoGPT mógłby mieć wtyczkę „Tool Finder”, która trafia do zewnętrznego API z zapytaniem naturalnym i dostaje sformatowaną odpowiedź. Będziemy śledzić te specyfikacje (np. CrewAI prawdopodobnie udostępni interfejs do obsługi MCP, a może i własny format discovery). Co więcej, w samej roadmapie MCP wskazano potrzebę ujednolicenia discovery – być może oficjalny rejestr od Anthropic udostępni własne API, z którym nasza platforma powinna być kompatybilna (by developer mógł łatwo przejść z jednego na drugi lub korzystać z wielu). Zakładamy zatem stworzenie REST API typu “/api/search” i “/api/list”, które zwróci wyniki w formacie JSON zawierającym wszystkie niezbędne dane do podjęcia decyzji przez agenta:
	•	unikalny identyfikator narzędzia w platformie,
	•	nazwę i krótki opis,
	•	kategorie/tagi,
	•	adres endpointu MCP (hostname/URL i port, ewentualnie ścieżka),
	•	listę funkcji dostępnych na tym serwerze (np. nazwy metod lub typowych akcji),
	•	informacje o wymaganiach dostępu (czy potrzebny token API, czy OAuth, czy otwarte),
	•	status online/offline,
	•	oceny (np. średnia gwiazdek),
	•	opcjonalnie odnośniki do dokumentacji.
Dzięki temu agent może np. wybrać narzędzie o ID X, sprawdzić że jest online i dostępne, a następnie podłączyć podając adres i ewentualny token. Format danych będzie zaprojektowany tak, by pokrywać się z specyfikacją MCP – np. jeśli protokół MCP definiuje standardowy manifest narzędzia (zawierający akcje i ich parametry), platforma może przechowywać taką strukturę lub link do niej. To ułatwi integrację: agent może bezpośrednio użyć opisu narzędzia, by wiedzieć jak go wywołać. W idealnym scenariuszu, agent pobiera z rejestru niemal gotowy payload do konfiguracji klienta MCP u siebie.
	•	Bezpieczeństwo i kontrola dostępu – choć pytanie nie wymienia tego explicite, warto zaznaczyć, że platforma powinna uwzględniać aspekty bezpieczeństwa. Nie wszystkie narzędzia powinny być automatycznie dostępne dla każdego agenta. Przewidujemy możliwość uwierzytelniania i autoryzacji przy pewnych operacjach: np. rejestracja nowego narzędzia może wymagać klucza API lub konta deweloperskiego, aby zapobiec spamowi. Również zapytania discovery od agentów mogą być ograniczane (np. przy bardzo dużej skali, wprowadzić klucze lub ograniczenia częstości). Jeśli chodzi o samą komunikację agent-narzędzie, to MCP wspiera OAuth 2.0 oraz inne mechanizmy – platforma będzie prezentować, jakiego typu uwierzytelnienie wymaga dane narzędzie (np. OAuth – link do uzyskania tokenu, API Key – informacja skąd wziąć klucz, itp.). Dzięki temu agent może w miarę możliwości zautomatyzować proces (np. otworzyć okno autoryzacji dla użytkownika, jeśli to aplikacja konsumencka, albo poprosić o wprowadzenie klucza API). Platforma może również wspomagać bezpieczne przechowywanie sekretów – choć raczej będzie to rola klienta MCP, nie samego rejestru. Niemniej, w interfejsie web, jeśli developer chce przetestować narzędzie, może zechcieć wpisać swój klucz API do testu – więc strona mogłaby oferować bezpieczne formularze do wypróbowania (podobnie do funkcji “try it out” w dokumentacjach API). Ten aspekt jednak jest poboczny i zależny od polityki – przyjmujemy, że zarządzanie dostępem do narzędzia jest po stronie dostawcy i/lub klienta, zaś rejestr tylko informuje o wymaganiach.

Architektura platformy i wymagane komponenty

Aby zrealizować powyższe funkcje, platforma SaaS będzie składała się z następujących głównych komponentów:
	•	Baza danych rejestru – przechowuje wszystkie zarejestrowane wpisy o serwerach MCP. Każdy wpis zawiera pola tekstowe (nazwa, opis, kategoria), listy (tagi, obsługiwane języki), pola techniczne (URL/host, port, wersja protokołu), pola statusowe (ostatnio widziany, dostępność), oraz powiązane tabele z ocenami, komentarzami, itp. Ważnym polem jest również typ udostępnianych prymitywów MCP (np. type: tools lub tools+resources – większość będzie typu narzędziowego). Baza danych musi umożliwiać zaawansowane zapytania filtrowujące, stąd przydatny będzie indeks full-text do wyszukiwania po opisie i tagach. Również mechanizm wyszukiwania semantycznego mógłby być wartością dodaną (agent mógłby sformułować pytanie opisowe, a rejestr znajdzie pasujące narzędzie nawet jeśli słowa kluczowe się nie pokrywają dokładnie). Jednak na początek wystarczą klasyczne filtry.
	•	Backend API (REST/GraphQL) – serwer aplikacji udostępniający endpointy dla frontendu oraz zewnętrznych klientów (agentów, twórców narzędzi). To tutaj zaimplementowana będzie logika rejestracji nowego narzędzia (np. walidacja danych, unikanie duplikatów), logika wyszukiwania (parsowanie parametrów zapytań, składanie odpowiedzi JSON) oraz logika aktualizacji wpisów (edycja przez właściciela, dodawanie ocen, itp.). Endpointy podzielimy na kilka grup:
	•	Publiczne API wyszukiwania – np. GET /api/tools/search?... do wyszukiwania według kryteriów; GET /api/tools/{id} do pobrania szczegółów pojedynczego wpisu; być może GET /api/tags czy GET /api/categories do uzyskania list dostępnych kategorii. Te endpointy będą używane przez agentów i wszelkie aplikacje klienckie.
	•	Publiczne API rejestracji – np. POST /api/tools/register do zgłoszenia nowego serwera. Zapytanie zawiera strukturę JSON z metadanymi. Można też przewidzieć PUT /api/tools/{id} do aktualizacji (tylko przez właściciela) oraz np. DELETE do wyrejestrowania jeśli ktoś wycofuje usługę.
	•	Publiczne API oceny/recenzji – np. POST /api/tools/{id}/rate czy POST /api/tools/{id}/review, dostępne dla zalogowanych użytkowników.
	•	Endpointy discovery dla agentów – być może będą to te same co wyszukiwania (jeśli agent może użyć standardowego GET), ewentualnie dedykowany uproszczony endpoint, np. GET /api/discover?query=... który przyjmie bardziej swobodne zapytanie językowe i zwróci listę kandydatów. Możliwe też wsparcie GraphQL, aby klient mógł w jednym zapytaniu pobrać np. listę narzędzi wraz z określonymi polami.
	•	Backend administracyjny – np. do moderacji wpisów, zarządzania użytkownikami, itp. (poza głównym zakresem koncepcji, ale wymagany dla utrzymania platformy).
Wszystkie te API będą dokumentowane, by twórcy agentów mogli łatwo z nich korzystać. Zapewnimy też, że odpowiedzi są zgodne z formatami JSON używanymi powszechnie – np. użycie camelCase lub snake_case konsekwentnie, wersjonowanie API (v1, v2) w razie przyszłych zmian.
	•	Frontend web (portal) – przyjazny interfejs www, gdzie użytkownik (np. deweloper) może przeglądać dostępne narzędzia, filtrować po kategoriach, czytać opisy i recenzje. Powinien oferować podgląd detali: np. wyświetlić listę funkcji dostępnych w ramach danego serwera MCP (np. serwer „Kalkulator” oferuje funkcje: dodawanie, odejmowanie, rozwiązywanie równań…). Te informacje mogą być pozyskiwane z bazy (jeśli dostawca je podał) lub dynamicznie z serwera MCP (wywołując np. metodę listCapabilities z protokołu MCP, jeśli taka istnieje). Portal będzie także zawierał opcję „Zarejestruj nowe narzędzie” – formularz dla twórców (wymagane logowanie), w którym wprowadzają oni wszystkie niezbędne dane. Dodatkowo panel użytkownika pozwoli im edytować informacje oraz zobaczyć statystyki (np. ile razy ich narzędzie zostało znalezione/pobrane przez agentów – co można śledzić poprzez zliczanie wywołań API związanych z ich wpisem).
	•	Moduł monitorowania i walidacji – w tle platformy działać będzie komponent odpowiedzialny za sprawdzanie poprawności i zdrowia zarejestrowanych serwerów. Przy dodaniu nowego narzędzia może on wykonać próbne połączenie: np. sprawdzić czy pod podanym URL/portem serwer MCP odpowiada (np. zawoła endpoint statusowy). Również cyklicznie co pewien czas (np. co godzinę) może pingować wszystkie aktywne wpisy. Wyniki zapisywane są w bazie (pole status). Ten moduł może też walidować zgodność ze specyfikacją MCP – np. korzystając z oficjalnego SDK, próbować pobrać listę dostępnych narzędzi z serwera i upewnić się, że zwraca on poprawny format. W razie wykrycia niezgodności, wpis może być oznaczony jako „możliwe problemy” albo wysłana informacja do twórcy. Taki monitoring zwiększy wiarygodność katalogu.
Ponadto, moduł ten może agregować statystyki użycia (o ile zbieramy takie informacje poprzez API – np. licznik pobrań). Dzięki temu w portalu można prezentować ranking popularności narzędzi czy trendów (co dodatkowo zachęci twórców do udziału, a użytkownikom wskaże co jest sprawdzone).
	•	Integracje z innymi katalogami/standardami – aby nie izolować się od reszty ekosystemu, platforma mogłaby oferować integrację z istniejącymi katalogami. Np. okresowo importować publiczne wpisy z oficjalnego repozytorium Anthropic czy z Githuba (Anthropic na GitHubie utrzymuje listę serwerów ￼). Można również użyć API innych serwisów (o ile dostępne) jak smithery.ai czy mcp.so do synchronizacji danych – choć tu ostrożnie, by nie dublować niezweryfikowanych wpisów. Alternatywnie, federacja rejestrów: skoro MCP jest otwartym standardem, możliwe że powstanie wiele rejestrów, które będą wymieniać się danymi. Nasza platforma może udostępnić część danych na licencji otwartej, aby np. ktoś mógł zbudować wyszukiwarkę meta-katalogów. To jednak kwestie przyszłościowe – na starcie skupiamy się na zbudowaniu własnej bazy i społeczności.

Przyszła integracja z agentami LLM i standardy agentowe

W miarę jak standard MCP będzie ewoluował, a agenci LLM staną się coraz bardziej autonomiczni, platforma musi nadążać za standardami komunikacji między agentami a katalogami narzędzi. Jak wspomniano, CrewAI i LangGraph – jako czołowe frameworki agentowe – już eksperymentują ze wsparciem dynamicznego dodawania narzędzi MCP ￼. Możliwe, że zostanie zdefiniowany pewien protokół discovery dedykowany agentom. Nasza platforma przewiduje to i jest gotowa wystawić odpowiedni endpoint discovery. Taki endpoint mógłby działać np. w modelu:
	•	Agent wysyła zapytanie (HTTP GET/POST) do https://nasz-rejestr.ai/discover z parametrami lub nawet pełnym zapytaniem w języku naturalnym. Może to zrobić poprzez wbudowany w agenta mechanizm (np. specjalna akcja “SearchToolsDirectory”).
	•	Platforma analizuje zapytanie i zwraca ustrukturyzowaną odpowiedź (JSON), która agent potrafi zinterpretować – np. listę {nazwa, opis, endpoint, ocena} posortowaną według trafności.
	•	Agent wybiera jedną z opcji i może wysłać kolejne zapytanie np. GET /discover/{tool_id}/manifest aby uzyskać szczegółowy manifest narzędzia (listę akcji, parametry) – lub bezpośrednio spróbuje zarejestrować korzystając z danych, które już ma.

Warto rozważyć, że AutoGPT i podobne inicjatywy autonomicznych agentów być może przyjmą nieco inne podejście – np. mogą utrzymywać lokalny zestaw wtyczek, a katalog zewnętrzny traktować jako ostateczność ze względów bezpieczeństwa. Jednak jeśli standard MCP się upowszechni, to nawet AutoGPT może dodać moduł do obsługi rejestru MCP. Nasza platforma będzie więc blisko współpracować z społecznością tych projektów, aby zapewnić kompatybilność. Być może zostaną opublikowane oficjalne biblioteki klienckie do korzystania z rejestrów MCP – wówczas wystarczy, że nasz rejestr spełni określony format (np. JSON schema dla listingów).

W integracji z agentami kluczowe jest też zarządzanie kontekstem i ograniczeniami. Użytkownik końcowy może chcieć kontrolować, z jakich katalogów agent może korzystać (żeby np. nie pobrał narzędzia z nieznanego źródła). Dlatego w ramach standardów discovery mogą pojawić się mechanizmy trust list – np. agent skonfigurowany w organizacji może mieć wpisane, by korzystał tylko z oficjalnego rejestru lub z naszego, ale już nie z niesprawdzonego źródła. Platforma, budując swoją markę i dbając o jakość wpisów, będzie aspirować do bycia tak zaufanym źródłem. Jeśli pojawi się formalna certyfikacja (jak sugeruje roadmap MCP ￼), nasz rejestr oczywiście zaimplementuje wymagane funkcje (np. podpisy cyfrowe manifestów narzędzi, aby agent mógł zweryfikować autentyczność kodu narzędzia – analogicznie do weryfikacji obrazów Dockerowych czy pakietów npm).

Podsumowując, platforma jest projektowana z myślą o przyszłości, w której agent AI samodzielnie zarządza swoim „toolboksem”. Ma stanowić brakujące ogniwo: hub łączący twórców narzędzi z agentami, tak by zwiększać możliwości sztucznej inteligencji w bezpieczny i skalowalny sposób.

Format danych i interfejsy API

Na koniec przyjrzyjmy się dokładniej, jakie formaty danych i API będą potrzebne, aby powyższe założenia urzeczywistnić:
	•	Format rejestracji narzędzia (input): Deweloper rejestrujący serwer MCP będzie wysyłał do naszego API JSON zawierający co najmniej:

{
  "name": "Nazwa narzędzia",
  "description": "Krótki opis działania narzędzia i jego przeznaczenia.",
  "url": "http(s)://host:port/...",  // adres bazowy serwera MCP
  "protocol_version": "MCP/1.2",    // wersja MCP jeśli istotna
  "capabilities": [ 
     /* lista akcji/zasobów, np: */
     { "name": "getWeather", "type": "resource", "description": "Pobiera prognozę pogody dla miasta." },
     { "name": "sendEmail", "type": "tool", "description": "Wysyła e-mail o podanej treści." }
  ],
  "categories": ["productivity", "email"], 
  "tags": ["email", "communication", "SMTP"],
  "language": ["en"],         // np. język interfejsu lub danych (opcjonalnie)
  "auth": { 
     "type": "api-key", 
     "instructions": "Zarejestruj się na example.com aby otrzymać klucz API."
  },
  "pricing": {
     "model": "free-tier", 
     "details": "Darmowe do 100 wysyłek dziennie, potem $0.001 za e-mail."
  }
}

Powyższy przykład jest hipotetyczny – finalny schemat będzie zapewne ustalony na podstawie specyfikacji MCP i standardu katalogu. Ważne, że zawiera zarówno metadane biznesowe (opis, kategorie, koszty) jak i techniczne (endpoint, wersje, lista akcji). Jeśli twórca nie chce ręcznie wypisywać wszystkich akcji, a jego serwer MCP potrafi je ujawnić automatycznie, platforma może zaoferować opcję: “Auto-detect capabilities” – wówczas spróbuje odpytać serwer (np. wywołując metodę protokołu discover czy pobierając manifest) i wypełni pole capabilities.
Ten format będzie używany w POST /api/tools/register. Dla wygody może być też obsługa form-data (np. poprzez formularz www) ale wewnętrznie konwertowane do JSON.

	•	Format odpowiedzi wyszukiwania (output): Kiedy agent lub użytkownik pyta rejestr o narzędzia, dostaje listę wyników. Format musi być zwięzły, ale zawierać kluczowe dane. Przykład odpowiedzi (dla zapytania o “weather”):

{
  "query": "weather",
  "results": [
    {
      "id": "tool_12345",
      "name": "OpenWeatherMCP",
      "description": "Dostarcza aktualną pogodę i prognozy. Źródło: OpenWeatherMap API.",
      "endpoint": "https://openweather.example.com/mcp",
      "status": "online",
      "tags": ["weather", "geography"],
      "rating": 4.8,
      "auth_required": false
    },
    {
      "id": "tool_67890",
      "name": "MeteoGPT",
      "description": "Zaawansowana usługa pogodowa z danymi historycznymi.",
      "endpoint": "https://api.meteoGPT.com",
      "status": "offline",
      "tags": ["weather", "climate"],
      "rating": 4.2,
      "auth_required": true
    }
  ]
}

Tutaj results to lista kandydatów. Każdy ma id (wewnętrzny identyfikator w rejestrze), nazwę, opis, adres endpointu MCP, prosty status oraz np. flagę czy wymaga autoryzacji. Można dodać inne pola jak kategorie, język, itp. Agent może na podstawie tego wyświetlić użytkownikowi listę lub automatycznie wybrać pierwszy (jeśli działa autonomicznie i np. preferuje te online). Następnie agent może wywołać np. GET /api/tools/tool_12345 aby pobrać pełne szczegóły:

{
  "id": "tool_12345",
  "name": "OpenWeatherMCP",
  "description": "Dostarcza aktualną pogodę...",
  "endpoint": "https://openweather.example.com/mcp",
  "protocol_version": "MCP/1.1",
  "capabilities": [
      { "name": "getCurrentWeather", "params": ["city"], "returns": "WeatherInfo" },
      { "name": "getForecast", "params": ["city","days"], "returns": "ForecastInfo" }
  ],
  "auth": { "type": "none" },
  "pricing": { "model": "free" },
  "owner": "OpenWeatherMap",
  "rating": 4.8,
  "reviews": [ ... ]
}

To pełen obraz zawierający wszystkie informacje potrzebne, by agent mógł zdecydować o rejestracji i użyciu. W polu capabilities widzimy np. dwie akcje z parametrami. Być może format ten mógłby być zgodny z jakąś definicją OpenAPI lub innym standardem, ale ponieważ MCP ma własny sposób opisu akcji, raczej trzymamy się terminologii MCP.

	•	API rejestru w kontekście MCP: Ciekawym pomysłem (opcjonalnym) jest sprawienie, aby sam rejestr również działał jako serwer MCP – co brzmiałoby meta-, ale pomyślmy: jeżeli agent już obsługuje protokół MCP, mógłby potencjalnie traktować rejestr jako kolejne narzędzie MCP typu resource. Rejestr mógłby mieć MCP-endpoint z jedną funkcją np. searchDirectory(query), która zwraca listę wyników. Wtedy agent mógłby przeszukiwać katalog tym samym mechanizmem, którym używa inne narzędzia (bez konieczności dodatkowego parsowania JSON z REST). Taką opcję warto rozważyć, jeśli standaryzacja pójdzie w tę stronę. Na razie jednak zakładamy klasyczne REST API, gdyż agent w razie potrzeby i tak potrafi wołać zewnętrzne API REST (np. za pomocą wbudowanego narzędzia HTTP).
	•	Dane statusowe i aktualizacje: Platforma może wysyłać powiadomienia do twórców narzędzi (np. e-mail/SMS/Webhook), gdy ich serwer jest odnotowany jako niedostępny, lub gdy pojawi się nowa recenzja. To jednak szczegół implementacyjny niezwiązany z MCP. Ważne, że platforma nie wysyła nic do agentów poza odpowiedziami na ich zapytania – chyba że agent sam subskrybuje jakieś powiadomienia (mało prawdopodobne, by to było potrzebne). W przyszłości, jeśli agenci będą obsługiwali WebSockety do katalogów, można oferować strumień nowo dodanych narzędzi albo zmian statusów – ale to raczej dodatkowa funkcja (np. “pokaż mi ostatnio dodane narzędzia w kategorii X”).

Podsumowanie

Proponowana platforma SaaS jako rejestr dla serwerów MCP wypełnia istotną lukę w rozwijającym się ekosystemie agentów AI. Umożliwia twórcom narzędzi łatwe dotarcie do użytkowników i agentów poprzez standaryzowany wpis w katalogu, bez konieczności hostowania swoich usług na cudzej infrastrukturze. Zapewnia przy tym agentom AI (modelom LLM) możliwość samodzielnego odnajdywania i dodawania nowych funkcjonalności w locie – co jest kluczowe dla budowy bardziej autonomicznych i wszechstronnych systemów AI. Platforma skupia się na agregowaniu rzetelnych metadanych (opisów, endpointów, statusów, ocen), ale pozostawia komunikację wykonawczą poza sobą, zgodnie z zasadą, że MCP jest protokołem end-to-end między agentem a narzędziem.

Analiza objęła zarówno bieżący stan standardu MCP (który z fazy nowinki przeszedł do etapu wdrażania przez głównych graczy, stając się de facto standardem ￼), jak i spojrzenie w przyszłość – uwzględniając planowane usprawnienia (oficjalny rejestr z certyfikacją ￼, integracja z A2A, bezpieczeństwo, standaryzacja formatów) oraz inicjatywy pokrewne (CrewAI, LangGraph, AutoGPT i in.). Zaproponowane formaty danych i API bazują na zasadach otwartości i zgodności ze specyfikacją MCP, tak by platforma mogła współdziałać z innymi elementami ekosystemu bez konfliktów.

W rezultacie otrzymujemy wizję marketplace dla narzędzi AI, analogicznego do sklepu z aplikacjami czy Docker Huba, dostosowanego do realiów inteligentnych agentów. Taka platforma przyspieszy rozwój społeczności MCP – im więcej narzędzi dostępnych w rejestrze, tym bardziej opłaca się implementować obsługę MCP w kolejnych agentach (efekt sieciowy) ￼. Z kolei dla użytkowników końcowych oznacza to bogatsze i bardziej elastyczne AI, które potrafi samo znaleźć narzędzie do rozwiązania danego problemu. Możemy więc spodziewać się, że wraz z dojrzałością standardów, koncepcja ta stanie się kluczowym elementem infrastruktury AI. Platforma zgodna z MCP, wspierająca discovery i rejestrację narzędzi, jest krokiem w kierunku zdecentralizowanej, interoperacyjnej przyszłości AI ￼, gdzie modele różnych producentów i narzędzia różnych dostawców współpracują bezproblemowo dla dobra użytkownika.

Źródła: Wszystkie powyższe założenia zostały opracowane w oparciu o dostępne opisy protokołu MCP oraz dyskusje w społeczności AI. Dla dalszej lektury na ten temat polecamy oficjalne ogłoszenie Anthropic o MCP ￼ ￼, analizę protokołu na blogu Neo4j (szczególnie rozdział o discovery i rejestrach) ￼ ￼, a także wpis na blogu HuggingFace omawiający znaczenie MCP jako standardu integracji AI ￼ ￼. Te materiały podkreślają, jak MCP zmienia sposób budowania agentów – i inspirują powstanie właśnie takiej platformy, jaką tu zaprojektowano.

Nasze USP vs. Smithery.ai i mcp.so:
	•	Weryfikacja + SLA – każdy MCP przechodzi automatyczne testy zdrowia, skan podatności i ciągły ping; w katalogu widzisz uptime/średnią latencję i jawne SLA, więc agent nie wybiera martwego narzędzia.   ￼ ￼
	•	Trust & Code-sign – podpisujemy manifesty (Ed25519). Agent może zweryfikować, że endpoint i kod są nadal tym samym, co podczas rejestracji (brak tego w Smithery/mcp.so).  ￼
	•	Semantic search API – pytasz LLM-em „potrzebuję narzędzia do fakturowania w PLN”, a dostajesz ranking ważony embeddingami i użytecznością; nie musisz znać tagów.   ￼
	•	Discovery as-a-Service – udostępniamy katalog również jako serwer MCP (resource searchDirectory), więc agent podłącza nas jednym poleceniem i sam sobie wyszukuje oraz rejestruje kolejne narzędzia – zero REST-owej “klepanki”.  ￼
	•	Versioning & breaking-change alerts – dostawca może wypuścić wiele wersji manifestu, a agenci dostają diff API z flagą breaking.
	•	Analityka dla dostawców – dashboard z anonimowymi statystykami użycia (call-count, median latency, top agent types) bez routowania ruchu przez nas; dane zbieramy z opcjonalnego lightweight web-hooka.
	•	Enterprise scopes – prywatne, samo-hostowane instancje katalogu (Docker, Helm) + RBAC, by korporacje mogły trzymać własne MCP obok publicznych.
	•	Federacja źródeł – importujemy publiczne wpisy z Smithery, mcp.so i oficjalnego repo Anthropic, eliminujemy duplikaty i oznaczamy źródło, więc masz „jedną szybką wyszukiwarkę” zamiast trzech.   ￼ ￼

Stawiamy na zaufanie, monitoring w czasie rzeczywistym i natywny “agent-friendly discovery”, czego brakuje w obecnych prostych listach MCP.

Jak to poskładać
	•	Manifest MCP – uzgadniamy prosty plik JSON (np. /.well-known/mcp.json) opisujący endpoint, wersję protokołu, listę akcji, wymagania auth.
	•	Tryb push – twórca uruchamia mcp register <URL> ( CLI lub GitHub-action). Manifest jest podpisany kluczem Ed25519; nasz endpoint /api/register weryfikuje podpis, ping-uje serwer, robi test call → wpis ląduje w katalogu w ~1 s.
	•	Tryb pull – crawler Worker chodzi po:
• feedach GitHub/NPM/PyPI z tagiem mcp-tool
• listach domen z TXT mcp=1 lub wpisem DNS-SRV _mcp._tcp
• publicznych katalogach (smithery, mcp.so)
Dla każdej znalezionej domeny pobiera manifest, testuje zdrowie, deduplikuje po fingerprintcie TLS/URL.
	•	Walidacja & sandbox – automatyczny e2e-test (ping, discover, jedna przykładowa akcja w dry-run). Nie przechodzi → status blocked.
	•	Bezpieczeństwo – podpis manifestu + opcjonalna weryfikacja DNS-TXT potwierdzają, że właściciel kontroluje domenę; Worker uruchamia test w ograniczonym runtime, więc złośliwy kod nie szkodzi.
	•	Aktualizacje – serwer MCP publikuje nagłówek MCP-Manifest-Version; gdy zmieni się hash, webhook wyzwala re-walidację i bump wersji w katalogu.

Całość da się zrobić na Cloudflare Workers + Durable Objects (rejestr + kolejka walidacji). Najtrudniejsze to polityka zaufania, nie aspekt techniczny. Podsumowując: automatyczne rejestrowanie MCP to kilkadziesiąt linii crawlera i walidatora – w pełni wykonalne, skalowalne i szybkie.

MVP – Cloudflare Workers + KV + R2, Node / wrangler
	1.	Bootstrap
	•	npm/pnpm create cf → repo mcpfinder
	•	wrangler dev + deploy CI (GitHub Actions)
	•	Environment vars: MCP_REGISTRY_SECRET, MCP_API_KEYS_KV, MCP_TOOLS_KV
	2.	Manifest spec v0.1
	•	/.well-known/mcp.json → name, url, version, capabilities[], auth, tags
	•	JSON schema in /schemas + AJV runtime validator
	3.	Data layer
	•	KV: tool:<uuid> → manifest JSON
	•	KV: index:tag:<tag> → Set<toolId>
	•	R2: raw manifest backup (manifests/<uuid>.json)
	•	KV: apikey:<hash> for publisher auth
	4.	Core API (Cloudflare Worker)
	•	POST /api/register    → auth header -> validate schema -> fetch(url) ping -> store in KV/R2
	•	GET  /api/tools/:id  → return manifest
	•	GET  /api/search?tag=&q= → simple filter (by tag OR full-text on name/description lowercase)
	•	JSON responses, CORS *
	5.	Publisher CLI (Node)
	•	npx @mcp/cli register <url> – reads local manifest, signs HMAC with MCP_REGISTRY_SECRET, calls /api/register
	•	Output success + toolId
	6.	Health-check Cron Trigger
	•	Every 15 min iterate tool:* keys → HEAD manifest url → update status=up/down
	7.	Rate-limiting & basic auth
	•	HMAC header for /register, free GET endpoints throttled (Workers env.AUTHPASS + DurableObjectRateLimiter)
	8.	Docs & landing
	•	Minimal static HTML in R2 (public/) served via Worker assetHandler
	9.	Release & feedback
	•	Deploy to custom domain via Cloudflare Pages → announce on e.g. Discord, collect bug reports

Dalsze kroki (roadmapa):

- MVP → Public beta	• UI frontend (React, HTMX) z wyszukiwarką• JWT-based publisher login• Web Console do podglądu własnych wpisów
- Trust Pack	• Manifest Ed25519 signatures + DNS TXT verify• Uptime/latency grafy (R2 logs → grafana.cloud)• Mail/Webhook alerty dla twórców
- Agent-native Discovery	• Worker wystawia MCP-endpoint searchDirectory• Semantyczne wyszukiwanie (OpenAI embeddings + KV-vector)
- Federacja	• Import z smithery.ai, mcp.so (deduplikacja sha256(url))• Public GraphQL federatedSearch
- Analytics Pro	• Lightweight call-counter webhook lib• Dashboard z agregatami (users, latency, geo)
- Enterprise / On-prem	• Helm chart - prywatna instancja z RBAC• SCIM SSO + Audit logs• SLA 99.9 % & dedicated support


Bottom line: MVP - działający rejestr (push + pull health-check), Pelna wersja – pełen ekosystem discovery, trust i analytics. Wszystko w 100 % na Cloudflare Workers, KV i R2, więc zerowa administracja serwerami.
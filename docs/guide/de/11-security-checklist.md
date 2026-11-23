# Sicherheits-Checkliste

Geh diese Liste vor dem Livegang und nach größeren Änderungen durch.

## Server und Netz

- [ ] Die Anwendung ist nur über einen Reverse Proxy mit HTTPS erreichbar; der
      Port der Anwendung (3000) ist an localhost oder ein privates Netz
      gebunden.
- [ ] `BASE_URL` beginnt mit `https://`, damit Sitzungs-Cookies als `Secure`
      markiert sind.
- [ ] `TRUST_PROXY` entspricht der Anzahl der Proxys vor der Anwendung, nie
      mehr; ist der Port der Anwendung ohne den Proxy erreichbar, enthält es
      stattdessen die Adressen des Proxys.
- [ ] Host, Docker und der Cluster bekommen Sicherheitsupdates.
- [ ] Das Image ist auf ein Release festgelegt (`OSP_VERSION=1.2.3`, `newTag`
      unter Kubernetes), optional auf seinen Digest, und im Produktivbetrieb
      nie `edge`.
- [ ] Neue Releases werden regelmäßig eingespielt (sie enthalten auch
      aktualisierte Basis-Images und Abhängigkeiten); jemand verfolgt die
      Releases des Repositorys. Baust du das Image selbst, baust du es
      regelmäßig neu.
- [ ] Images kommen nur von `ghcr.io/raphael-penning/openstatuspage`, aus
      deinem eigenen Build oder aus einem Mirror, den du kontrollierst.
- [ ] Nur die Ports des Proxys (80/443) sind aus dem Internet erreichbar.
      PostgreSQL ist nicht veröffentlicht.
- [ ] Getrennter Betrieb: Die `public`-Instanz meldet sich mit einer eigenen,
      eingeschränkten Rolle an (`DB_PUBLIC_ROLE`, angelegt mit
      `deploy/postgres/roles.sql`), `ALLOW_UNRESTRICTED_PUBLIC_DB` ist nicht
      gesetzt; sie bekommt `SUBSCRIPTION_TOKEN_KEY`,
      aber nicht `SECRET_KEY`; den Admin-Host erreichst du nicht aus dem
      Internet. Siehe [Sicherheitsmodell](../../security-model.md).

## Geheimnisse

- [ ] `SECRET_KEY` ist zufällig (`openssl rand -base64 48`), pro Installation
      eindeutig und zusätzlich sicher außerhalb des Servers aufbewahrt.
- [ ] `POSTGRES_PASSWORD`, `SMTP_PASSWORD` und das OIDC-Client-Secret sind
      zufällig und werden nirgends sonst verwendet.
- [ ] `.env` (und jede andere Env-Datei) ist nur für root oder den
      Dienstbenutzer lesbar (`chmod 600`) und in keinem Repository
      eingecheckt.
- [ ] Eine Kopie von `.env`, mindestens aber `SECRET_KEY` und
      `POSTGRES_PASSWORD`, liegt an einem sicheren Ort außerhalb des Servers.
- [ ] Unter Kubernetes ist das Secret `openstatuspage` mit `kubectl` oder
      einem Secret-Manager angelegt, liegt nie im Klartext in Git, und nur
      wenige Personen dürfen Secrets im Namespace lesen.
- [ ] `ADMIN_PASSWORD` wurde nach dem ersten Start aus der Umgebung entfernt.

## Kubernetes

- [ ] Der Security Context aus `deployment.yaml` ist unverändert: Benutzer
      1000 statt root, keine Rechteausweitung, alle Capabilities entfernt,
      schreibgeschütztes Root-Dateisystem, Seccomp-Profil `RuntimeDefault`.
- [ ] Nur der Ingress ist von außen erreichbar; der Service bleibt
      `ClusterIP`.
- [ ] Ein Replikat, oder mehrere nur wie unter
      [Mehrere Instanzen betreiben](09-operations.md#mehrere-instanzen-betreiben)
      beschrieben.
- [ ] Die Datenbank ist von außerhalb des Clusters bzw. des Datenbanknetzes
      nicht erreichbar.

## Konten und Zugriff

- [ ] Jede Person hat ein eigenes Konto; niemand teilt sich den ersten
      Administrator.
- [ ] Wenige Administratoren; wer nur über Vorfälle informiert, ist
      Redakteur.
- [ ] Ehemalige Teammitglieder sind gelöscht (ihre API-Tokens werden dabei
      widerrufen).
- [ ] Mit Single Sign-On: `OIDC_ADMIN_GROUP` / `OIDC_EDITOR_GROUP` sind
      gesetzt, `OIDC_AUTO_CREATE_USERS` ist nur zusammen mit ihnen aktiv, und
      der Issuer ist dein eigener Mandant, nie ein öffentlicher
      Multi-Tenant-Endpunkt.
- [ ] In der Verwaltung angelegte SSO-Anbieter sind mit erlaubten E-Mail-Domains
      oder mit *Kein Zugriff* als Standardrolle eingeschränkt, und *Benutzer bei
      der ersten Anmeldung anlegen* bleibt aus, solange du es nicht brauchst.
- [ ] `LOCAL_LOGIN_ENABLED=false` erwägen, sobald Single Sign-On für
      mindestens einen Administrator funktioniert.
- [ ] API-Tokens haben die kleinste Rolle, die reicht, aussagekräftige Namen,
      und ungenutzte Tokens sind widerrufen.
- [ ] Das Audit-Log wird ab und zu durchgesehen.

## Monitoring-Anbindung

- [ ] Ist die Statusseite aus dem Internet erreichbar, wird Push verwendet,
      sodass auf ihr keine Monitoring-Zugangsdaten liegen.
- [ ] Zugangsdaten für Pull gehören zu einem eigenen Nur-Lese-Benutzer, der
      auf die relevanten Objekte beschränkt ist.
- [ ] Die TLS-Prüfung ist für alle Quellen aktiv; interne CAs sind mit
      `NODE_EXTRA_CA_CERTS` hinzugefügt.
- [ ] Ingest-Tokens werden wo möglich im `Authorization`-Header gesendet und
      erneuert, wenn sie bekannt geworden sein könnten.

## Öffentliche Inhalte

- [ ] Service-Namen, Beschreibungen sowie Texte von Vorfällen und Wartungen
      enthalten keine internen Hostnamen, IP-Adressen oder Systemnamen.
- [ ] Services, Gruppen und Standorte, die nicht öffentlich sein dürfen, sind
      versteckt.
- [ ] Footer-Links verweisen auf Impressum und Datenschutzerklärung.
- [ ] Soll die Seite nicht anderswo eingebettet werden, sendet der Proxy
      `Content-Security-Policy: frame-ancestors 'self'`.

## E-Mail

- [ ] SMTP nutzt TLS: `SMTP_SECURE=true` oder ein Server, der STARTTLS
      anbietet (mit `SMTP_SECURE=false` wird STARTTLS nur genutzt, wenn der
      Server es anbietet); `SMTP_TLS_REJECT_UNAUTHORIZED` bleibt `true`.
- [ ] SPF, DKIM und DMARC sind für die Absender-Domain eingerichtet.
- [ ] Die Datenschutzerklärung beschreibt die E-Mail-Abonnements (Zweck,
      Speicherung, Abmeldung) und ist im Footer verlinkt.
- [ ] `MAIL_TRANSPORT=log` wird nicht produktiv genutzt: Es wird keine
      E-Mail versendet. (Mit `NODE_ENV=production` sind die Tokens der
      geloggten Links geschwärzt; in anderen Modi enthält das Log
      funktionierende Bestätigungs- und Verwaltungslinks.)

## Betrieb

- [ ] Sicherungen der Datenbank laufen automatisch, liegen außerhalb des Hosts,
      und eine Wiederherstellung wurde getestet.
- [ ] `SECRET_KEY` ist getrennt von der Datenbank gesichert.
- [ ] Die Statusseite wird von außerhalb deiner Infrastruktur überwacht.
- [ ] Nur eine Instanz führt den Hintergrund-Worker aus.

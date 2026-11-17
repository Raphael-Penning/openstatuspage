# Sicherheits-Checkliste

Geh diese Liste vor dem Livegang und nach größeren Änderungen durch.

## Server und Netz

- [ ] Die Anwendung ist nur über einen Reverse Proxy mit HTTPS erreichbar; der
      Port der Anwendung (3000) ist an localhost oder ein privates Netz
      gebunden.
- [ ] `BASE_URL` beginnt mit `https://`, damit Sitzungs-Cookies als `Secure`
      markiert sind.
- [ ] `TRUST_PROXY` entspricht der Anzahl der Proxys vor der Anwendung, nie
      mehr.
- [ ] Host, Docker und die Basis-Images bekommen Sicherheitsupdates; die
      Anwendung wird regelmäßig neu gebaut (`docker compose ... up -d --build`).
- [ ] Nur die Ports des Proxys (80/443) sind aus dem Internet erreichbar.
      PostgreSQL ist nicht veröffentlicht.

## Geheimnisse

- [ ] `SECRET_KEY` ist zufällig (`openssl rand -base64 48`), pro Installation
      eindeutig und zusätzlich sicher außerhalb des Servers aufbewahrt.
- [ ] `POSTGRES_PASSWORD`, `SMTP_PASSWORD` und das OIDC-Client-Secret sind
      zufällig und werden nirgends sonst verwendet.
- [ ] Env-Dateien sind nur für root oder den Dienstbenutzer lesbar
      (`chmod 600`) und in keinem Repository eingecheckt.
- [ ] `ADMIN_PASSWORD` wurde nach dem ersten Start aus der Umgebung entfernt.

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

- [ ] SMTP nutzt TLS (`SMTP_SECURE=true` oder STARTTLS);
      `SMTP_TLS_REJECT_UNAUTHORIZED` bleibt `true`.
- [ ] SPF, DKIM und DMARC sind für die Absender-Domain eingerichtet.
- [ ] Die Datenschutzerklärung beschreibt die E-Mail-Abonnements (Zweck,
      Speicherung, Abmeldung).

## Betrieb

- [ ] Sicherungen der Datenbank laufen automatisch, liegen außerhalb des Hosts,
      und eine Wiederherstellung wurde getestet.
- [ ] `SECRET_KEY` ist getrennt von der Datenbank gesichert.
- [ ] Die Statusseite wird von außerhalb deiner Infrastruktur überwacht.
- [ ] Nur eine Instanz führt den Hintergrund-Worker aus.

import express from "express";
import cors from "cors";
import axios from "axios";
import * as cheerio from "cheerio";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: "https://recicle20.vercel.app" }));
app.use(express.json());

// Serve o frontend (arquivos estáticos) direto pelo mesmo servidor
app.use(express.static(path.join(__dirname, "..", "frontend")));

// ---------------------------------------------------------------
// 1) CEP -> Endereço (ViaCEP)
// ---------------------------------------------------------------
async function buscarEnderecoPorCep(cep) {
  const cepLimpo = cep.replace(/\D/g, "");
  if (cepLimpo.length !== 8) {
    throw new Error("CEP inválido. Digite 8 números.");
  }

  const { data } = await axios.get(
    `https://viacep.com.br/ws/${cepLimpo}/json/`
  );

  if (data.erro) {
    throw new Error("CEP não encontrado.");
  }

  // Monta o endereço no mesmo formato usado pelo eCycle
  // Ex: "Rua Bartolomeo Bon - Jardim Dracena, São Paulo - SP, 05528-200, Brasil"
  const enderecoCompleto = `${data.logradouro} - ${data.bairro}, ${data.localidade} - ${data.uf}, ${data.cep}, Brasil`;

  return { ...data, enderecoCompleto };
}

// ---------------------------------------------------------------
// 2) CEP -> Lat/Long
//
// A BrasilAPI continua sendo a fonte PRINCIPAL (ela calcula a
// coordenada direto do CEP, é rápida e não depende de um serviço
// de terceiro instável). O problema: pra CEPs de áreas periféricas,
// pouco mapeadas, ela às vezes devolve uma coordenada aproximada
// da região em vez de recusar — e não tem como saber isso só
// olhando a resposta dela.
//
// Por isso adicionamos UMA checagem de sanidade: comparamos a
// coordenada da BrasilAPI com uma busca rápida só pelo BAIRRO
// (que já vem do ViaCEP). Se as duas baterem perto, confiamos na
// BrasilAPI (mais precisa quando funciona). Se vierem muito
// distantes uma da outra dentro da mesma cidade — sinal de que a
// BrasilAPI "chutou" — usamos a do bairro no lugar.
// ---------------------------------------------------------------
async function buscarCoordenadasPorCep(cepLimpo) {
  try {
    const { data } = await axios.get(
      `https://brasilapi.com.br/api/cep/v2/${cepLimpo}`
    );
    const lat = data?.location?.coordinates?.latitude;
    const lon = data?.location?.coordinates?.longitude;
    if (lat && lon) {
      return { lat: parseFloat(lat), lon: parseFloat(lon) };
    }
  } catch (e) {
    // segue pro fallback abaixo
  }
  return null;
}

async function geocodificarCidade(localidade, uf) {
  const { data } = await axios.get(
    "https://nominatim.openstreetmap.org/search",
    {
      params: {
        q: `${localidade} - ${uf}, Brasil`,
        format: "json",
        limit: 1,
        countrycodes: "br",
      },
      headers: { "User-Agent": "recicle-app/1.0 (uso pessoal/estudo)" },
    }
  );
  if (data && data.length > 0) {
    return { lat: parseFloat(data[0].lat), lon: parseFloat(data[0].lon) };
  }
  return null;
}

async function geocodificarBairro(bairro, localidade, uf) {
  if (!bairro) return null;
  try {
    const { data } = await axios.get(
      "https://nominatim.openstreetmap.org/search",
      {
        params: {
          q: `${bairro}, ${localidade} - ${uf}, Brasil`,
          format: "json",
          limit: 1,
          countrycodes: "br",
        },
        headers: { "User-Agent": "recicle-app/1.0 (uso pessoal/estudo)" },
      }
    );
    if (data && data.length > 0) {
      return { lat: parseFloat(data[0].lat), lon: parseFloat(data[0].lon) };
    }
  } catch (e) {
    // sem problema, é só uma checagem — segue sem ela
  }
  return null;
}

function distanciaKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Se a BrasilAPI e o bairro discordarem em mais que isso, algo
// está errado — provavelmente a BrasilAPI "chutou" a coordenada.
// (Bairros vizinhos raramente ficam a mais de poucos km um do
// outro — 13km de diferença, por exemplo, já é sinal de erro.)
const LIMITE_DIVERGENCIA_KM = 5;

async function geocodificarEndereco({ cepLimpo, bairro, localidade, uf }) {
  const porCep = await buscarCoordenadasPorCep(cepLimpo);
  const porBairro = await geocodificarBairro(bairro, localidade, uf);

  if (porCep && porBairro) {
    const divergencia = distanciaKm(
      porCep.lat,
      porCep.lon,
      porBairro.lat,
      porBairro.lon
    );

    if (divergencia <= LIMITE_DIVERGENCIA_KM) {
      console.log(
        `      -> Coordenadas via BrasilAPI (bate com o bairro, ${divergencia.toFixed(
          1
        )}km de diferença) — alta confiança`
      );
      return { ...porCep, fonte: "cep" };
    }

    console.log(
      `      -> BrasilAPI descartada: ${divergencia.toFixed(
        0
      )}km de diferença do bairro informado (provável coordenada aproximada)`
    );
    console.log("      -> Usando coordenadas do BAIRRO no lugar");
    return { ...porBairro, fonte: "bairro" };
  }

  if (porCep) {
    console.log(
      "      -> Coordenadas via BrasilAPI (não deu pra checar contra o bairro)"
    );
    return { ...porCep, fonte: "cep" };
  }

  if (porBairro) {
    console.log("      -> Coordenadas via Nominatim (bairro)");
    return { ...porBairro, fonte: "bairro" };
  }

  const porCidade = await geocodificarCidade(localidade, uf);
  if (porCidade) {
    console.log(
      "      -> Coordenadas via Nominatim (centro da cidade, aproximado)"
    );
    return { ...porCidade, fonte: "cidade" };
  }

  throw new Error(
    "Não foi possível localizar esse endereço no mapa. Tente um CEP diferente."
  );
}

// ---------------------------------------------------------------
// 3) Codifica o e-mail no formato usado pelo eCycle (ASCII, vírgula)
// ---------------------------------------------------------------
function codificarEmail(email) {
  return (
    email
      .split("")
      .map((c) => c.charCodeAt(0))
      .join(",") + ","
  );
}

// ---------------------------------------------------------------
// 4) Consulta o eCycle e extrai os postos com Cheerio
//
// IMPORTANTE: o eCycle roda num backend PHP bem antigo (5.6) que
// interpreta a query string de forma "crua". Se deixarmos o axios
// montar a URL sozinho (via `params`), ele escapa vírgula/parênteses
// de um jeito que o servidor não reconhece e a busca volta vazia,
// mesmo com status 200. Por isso montamos a URL manualmente aqui,
// replicando exatamente a codificação que o navegador usa
// (encodeURI, que preserva vírgula e parênteses, só troca espaço
// por %20) — assim ela funciona igual pra QUALQUER busca, não só
// pra este teste específico.
// ---------------------------------------------------------------
function montarUrlEcycle({ geocode, enderecoCompleto, item, itemcategoria, email, pagina }) {
  const geocodeStr = `(${geocode.lat}, ${geocode.lon})`;

  const parametros = [
    ["option", "com_ola"],
    ["geocode", geocodeStr],
    ["cep", enderecoCompleto],
    ["item", item],
    ["itemcategoria", itemcategoria],
    ["email", codificarEmail(email)],
    ["recebe", "false"],
    ["pagina", String(pagina)],
  ];

  const queryString = parametros
    .map(([chave, valor]) => `${chave}=${encodeURI(String(valor))}`)
    .join("&");

  return `https://www.ecycle.com.br/index.php?${queryString}`;
}

async function buscarUmaPaginaEcycle({
  geocode,
  enderecoCompleto,
  item,
  itemcategoria,
  email,
  pagina = 1,
}) {
  const urlFinal = montarUrlEcycle({
    geocode,
    enderecoCompleto,
    item,
    itemcategoria,
    email,
    pagina,
  });

  console.log(`      -> URL enviada: ${urlFinal}`);

  const { data: html } = await axios.get(urlFinal, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
      "Accept-Language": "pt-BR,pt;q=0.9",
      Referer: "https://www.ecycle.com.br/postos/reciclagem.php",
    },
  });

  // Salva a última resposta bruta pra facilitar debug (abra esse
  // arquivo no navegador se algo parecer errado)
  fs.writeFileSync(
    path.join(__dirname, "debug-ultima-resposta.html"),
    html
  );

  const $ = cheerio.load(html);

  const totalPostosTexto = $(".destaquePostos").text().trim();
  const raioTexto = $(".destaqueDistancia").text().trim();

  console.log(`      -> HTML recebido: ${html.length} caracteres`);
  console.log(`      -> Texto ".destaquePostos": "${totalPostosTexto}"`);
  console.log(`      -> Elementos ".itemBusca" encontrados: ${$(".itemBusca").length}`);

  const postos = [];
  $(".itemBusca").each((_, el) => {
    const nome = $(el).find("h6").text().trim();
    const distancia = $(el)
      .find(".itensAbaixoBusca p")
      .text()
      .replace("Distância:", "")
      .trim();
    const link = $(el).find("a.vermais").attr("href");

    if (nome) {
      postos.push({ nome, distancia, link });
    }
  });

  // Verifica quantas páginas de resultado existem
  const totalPaginas = $(".linkPaginacao")
    .filter((_, el) => !isNaN(parseInt($(el).text().trim())))
    .length;

  return {
    totalPostosTexto,
    raioTexto,
    totalPaginas: totalPaginas || 1,
    postos,
  };
}

// ---------------------------------------------------------------
// 5) Filtra por raio (km), buscando páginas extras automaticamente
//
// O eCycle sempre devolve os resultados ordenados por distância
// crescente. Aproveitamos isso: se o raio pedido for, por exemplo,
// 2km, buscamos página por página e paramos assim que aparecer um
// posto além desse limite — não precisa varrer tudo.
//
// Se `raioMaxKm` não for informado, mantém o comportamento antigo
// (mostra só a 1ª página, sem filtro, com paginação manual).
// ---------------------------------------------------------------
function distanciaParaNumero(distanciaStr) {
  const match = String(distanciaStr).match(/([\d.,]+)/);
  return match ? parseFloat(match[1].replace(",", ".")) : Infinity;
}

const MAX_PAGINAS_VARREDURA = 5; // trava de segurança (até 50 postos)

async function buscarPostosComRaio({
  geocode,
  enderecoCompleto,
  item,
  itemcategoria,
  email,
  raioMaxKm,
  pagina, // usado só quando NÃO há filtro de raio (paginação manual)
}) {
  // Sem filtro de raio: comportamento antigo, uma página por vez
  if (!raioMaxKm) {
    return buscarUmaPaginaEcycle({
      geocode,
      enderecoCompleto,
      item,
      itemcategoria,
      email,
      pagina: pagina || 1,
    });
  }

  let paginaAtual = 1;
  let totalPaginas = 1;
  let totalPostosTexto = "";
  let raioTexto = "";
  const postosFiltrados = [];
  let atingiuLimite = false;

  do {
    const resultadoPagina = await buscarUmaPaginaEcycle({
      geocode,
      enderecoCompleto,
      item,
      itemcategoria,
      email,
      pagina: paginaAtual,
    });

    if (paginaAtual === 1) {
      totalPostosTexto = resultadoPagina.totalPostosTexto;
      raioTexto = resultadoPagina.raioTexto;
      totalPaginas = resultadoPagina.totalPaginas;
    }

    for (const posto of resultadoPagina.postos) {
      if (distanciaParaNumero(posto.distancia) <= raioMaxKm) {
        postosFiltrados.push(posto);
      } else {
        atingiuLimite = true;
        break;
      }
    }

    paginaAtual++;
  } while (
    !atingiuLimite &&
    paginaAtual <= totalPaginas &&
    paginaAtual <= MAX_PAGINAS_VARREDURA
  );

  console.log(
    `      -> Filtro de raio (${raioMaxKm}km): ${postosFiltrados.length} postos dentro do limite`
  );

  return {
    totalPostosTexto,
    raioTexto,
    totalPaginas: 1, // já veio tudo agregado, não precisa paginação manual
    postos: postosFiltrados,
  };
}

// ---------------------------------------------------------------
// ROTA PRINCIPAL: recebe os dados do formulário e retorna os postos
// ---------------------------------------------------------------
app.post("/api/buscar-postos", async (req, res) => {
  try {
    const { cep, item, itemcategoria, email, pagina, raioMaxKm } = req.body;

    if (!cep || !item || !itemcategoria || !email) {
      return res.status(400).json({
        erro: "Preencha CEP, tipo de material e e-mail.",
      });
    }

    // Passo 1: CEP -> endereço
    console.log(`[1/3] Buscando endereço pro CEP ${cep}...`);
    const enderecoInfo = await buscarEnderecoPorCep(cep);
    console.log(`      -> ${enderecoInfo.enderecoCompleto}`);

    // Passo 2: endereço -> coordenadas
    console.log("[2/3] Geocodificando endereço...");
    const geocode = await geocodificarEndereco({
      cepLimpo: cep.replace(/\D/g, ""),
      logradouro: enderecoInfo.logradouro,
      bairro: enderecoInfo.bairro,
      localidade: enderecoInfo.localidade,
      uf: enderecoInfo.uf,
    });
    console.log(`      -> lat: ${geocode.lat}, lon: ${geocode.lon}`);

    // Passo 3: buscar os postos no eCycle (com filtro de raio, se pedido)
    console.log(
      `[3/3] Consultando postos no eCycle${
        raioMaxKm ? ` (raio máx: ${raioMaxKm}km)` : ""
      }...`
    );
    const resultado = await buscarPostosComRaio({
      geocode,
      enderecoCompleto: enderecoInfo.enderecoCompleto,
      item,
      itemcategoria,
      email,
      pagina: pagina || 1,
      raioMaxKm: raioMaxKm ? Number(raioMaxKm) : null,
    });

    console.log(`      -> ${resultado.postos.length} postos encontrados`);

    res.json({
      endereco: enderecoInfo.enderecoCompleto,
      precisaoLocalizacao: geocode.fonte,
      ...resultado,
    });
  } catch (err) {
    console.error("Erro na busca:", err.message);
    res.status(500).json({ erro: err.message || "Erro ao buscar postos." });
  }
});

app.listen(PORT, () => {
  console.log(`Servidor Recicle rodando em http://localhost:${PORT}`);
});

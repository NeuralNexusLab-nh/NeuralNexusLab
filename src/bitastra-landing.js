import "./bitastra.css";
import {
  chooseLanguage,
  copy,
  languages,
  setLanguage,
} from "./bitastra-common.js";
let lang = chooseLanguage();
const picker = document.querySelector("#language");
for (const [value, label] of Object.entries(languages))
  picker.add(new Option(label, value));
function render() {
  document.documentElement.lang = lang;
  picker.value = lang;
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    el.textContent = copy[lang][el.dataset.i18n] || copy.en[el.dataset.i18n];
  });
}
picker.addEventListener("change", () => {
  lang = picker.value;
  setLanguage(lang);
  render();
});
render();
